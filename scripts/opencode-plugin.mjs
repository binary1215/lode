import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeObservationStore, nativeId, projectNativeObservations, appendNativeStatus } from "./lib/native-session-observations.mjs";
import { createSessionHostAdapter } from "./lib/session-host-adapter.mjs";
import { startupProjection, MAX_CONTEXT_CHARACTERS } from "./lib/session-host-context-projection.mjs";
import { resolveOperation } from "./lib/lode-operation-contract.mjs";
import { assessSubagentStateWrite, subagentWriteGuardEnabled } from "./lib/subagent-write-guard.mjs";
import { resolveProjectStorage, assertProjectStorageUnchanged } from "./lib/project-storage-format.mjs";
import { safeGraphFile } from "./lib/discovery-index.mjs";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";
import { appendUserPromptReference, captureUserPrompt, freezeUserPromptReference, prepareUserPromptReference, acknowledgeUserPromptReference } from "./lib/user-prompt-reference.mjs";
import { deliverQueuedOpenCode, prepareOpenCodeInjection, registerOpenCodePresence, writeOpenCodeCallerTicket } from "./lib/conversation-messaging.mjs";

// Dependency-free OpenCode V1 server entry, source-shaped against v1.19.0.
// No client creation, daemon, auth/config edits or canonical HEAD mutation.
const sanitize = name => name.replace(/[^a-zA-Z0-9_-]/gu, "_");
const packagedServer = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const portableOpenCodeScript = "{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs";
const real = p => fs.realpathSync(path.resolve(p));
const samePath = (a, b) => real(a) === real(b);
function ownsPortableLaunch(directory, name, command) {
  const storage = resolveProjectStorage(directory);
  if (!storage) return false;
  const project = JSON.parse(fs.readFileSync(storage.projectFile, "utf8"));
  if (project.integrations?.opencode?.status !== "managed" || project.integrations.opencode.path !== "opencode.json") return false;
  const manifest = JSON.parse(fs.readFileSync(safeGraphFile(storage.projectRoot, `${storage.directory}/generated/manifest.json`), "utf8"));
  const packageRoot = path.dirname(path.dirname(packagedServer));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"));
  if (!samePath(manifest.pluginRoot, packageRoot) || manifest.packageVersion !== pkg.version || plugin.version !== pkg.version
    || pkg.name !== ARTIFACT_COMPOSITION.packageName || plugin.name !== ARTIFACT_COMPOSITION.pluginName) return false;
  const bytes = fs.readFileSync(safeGraphFile(storage.projectRoot, "opencode.json"));
  const owned = manifest.managed?.filter(entry => entry.path === "opencode.json");
  if (owned?.length !== 1 || crypto.createHash("sha256").update(bytes).digest("hex") !== owned[0].sha256) return false;
  const original = JSON.parse(bytes.toString("utf8")).mcp;
  const item = original && Object.hasOwn(original, name) ? original[name] : null;
  if (item?.type !== "local" || item.command?.length !== 2 || item.command[0] !== command[0]
    || item.command[1] !== portableOpenCodeScript) return false;
  assertProjectStorageUnchanged(storage);
  return true;
}
const supportedEvents = new Map([["session.created", "start-observed"], ["session.status", "status-observed"],
  ["session.idle", "idle-observed"], ["session.deleted", "caller-deleted-observed"], ["session.error", "error-observed"]]);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
async function bounded(call) {
  const controller = new AbortController(); let timer;
  try {
    const result = await Promise.race([call(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Optional native lookup timed out.")); }, 750);
    })]);
    if (!object(result) || result.error || Buffer.byteLength(JSON.stringify(result.data)) > 64 * 1024) return null;
    return result.data;
  } catch { return null; } finally { clearTimeout(timer); }
}
export default {
  id: "head-agent-native-observations",
  async server({ client, project, directory }, { environment = process.env } = {}) {
    let aliases = new Map(), serverPrefixes = [], disposed = false, pending = 0, queue = Promise.resolve();
    const userMessages = new Map();
    function promptCaller(sessionID) {
      return nativeId(sessionID) ? { root: directory, runtime: "opencode", nativeSessionId: sessionID, environment } : null;
    }
    function notePromptEvent(event) {
      const type = event?.type;
      if (type === "message.updated") {
        const info = event.properties?.info;
        if (info?.role === "user" && nativeId(info.id) && nativeId(info.sessionID)) {
          userMessages.set(info.id, info.sessionID);
          while (userMessages.size > 64) userMessages.delete(userMessages.keys().next().value);
        }
        return;
      }
      if (type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type !== "text" || part.synthetic === true || typeof part.text !== "string") return;
        if (!nativeId(part.messageID) || userMessages.get(part.messageID) !== part.sessionID) return;
        const caller = promptCaller(part.sessionID);
        if (caller) captureUserPrompt({ ...caller, text: part.text, messageId: part.messageID });
        return;
      }
      if (type === "session.compacted") {
        const caller = promptCaller(event.properties?.sessionID);
        if (caller) freezeUserPromptReference(caller);
        return;
      }
      if (type === "command.executed" && (event.properties?.name === "clear" || event.properties?.command === "clear")) {
        const caller = promptCaller(event.properties?.sessionID);
        if (caller) freezeUserPromptReference(caller);
      }
    }
    let contextSupported = true, deliveries = new WeakMap(), watcher = null;
    const activeSessionIds = new Set();
    const store = createNativeObservationStore({ environment });
    function watchInbox() {
      if (watcher || disposed) return;
      try {
        const storage = resolveProjectStorage(directory);
        if (!storage) return;
        const inbox = path.join(storage.projectRoot, storage.directory, "messaging", "inbox");
        if (!fs.existsSync(inbox)) return;
        watcher = fs.watch(inbox, { recursive: true }, () => {
          deliverQueuedOpenCode({ root: directory, client, directory, environment, skipSessionIds: [...activeSessionIds] }).catch(() => {});
        });
        watcher.unref?.();
      } catch { watcher = null; }
    }
    function registerIfMailbox(session) {
      const storage = resolveProjectStorage(directory);
      if (!storage || !fs.existsSync(path.join(storage.projectRoot, storage.directory, "messaging"))) return;
      registerOpenCodePresence({ root: directory, session, client, environment });
      watchInbox();
    }
    const caller = id => ({ runtime: "opencode", nativeSessionId: id, agentId: null });
    function sessionScope(session, id) {
      try {
        return !disposed && nativeId(id) && nativeId(project?.id) && session?.id === id && session.projectID === project.id
          && typeof session.directory === "string" && session.directory.length <= 32768 && samePath(session.directory, directory);
      } catch { return false; }
    }
    async function exactSession(id) {
      if (disposed || !nativeId(id) || !nativeId(project?.id) || typeof directory !== "string") return null;
      const session = await bounded(signal => client.session.get({ path: { id }, query: { directory }, signal }));
      return sessionScope(session, id) ? session : null;
    }
    function enqueue(operation) {
      if (disposed || pending >= 64) return Promise.resolve();
      pending++;
      const work = queue.then(() => disposed ? undefined : operation()).catch(() => {}).finally(() => { pending--; });
      queue = work; return work;
    }
    return {
      async config(config) {
        aliases = new Map();
        serverPrefixes = [];
        contextSupported = config?.experimental?.code_mode !== true;
        if (disposed || config?.experimental?.code_mode === true) return;
        const entries = Object.entries(config?.mcp || {}), counts = new Map();
        for (const [name] of entries) counts.set(sanitize(name), (counts.get(sanitize(name)) || 0) + 1);
        for (const [name, item] of entries) {
          // Only this packaged local server command, not a matching suffix or
          // a remote server calling itself HEAD. Sanitized collisions skip both.
          if (counts.get(sanitize(name)) !== 1 || item?.type !== "local" || item.enabled === false
            || !Array.isArray(item.command) || item.command.length !== 2 || typeof item.command[0] !== "string"
            || !/^(node|node\.exe)$/iu.test(path.basename(item.command[0])) || typeof item.command[1] !== "string") continue;
          try {
            // OpenCode substitutes env before config hooks; an unset root is
            // already /scripts/..., not the literal placeholder. Repair only
            // the exact owned original and current package, in memory.
            if ([portableOpenCodeScript, "/scripts/mcp-server.mjs"].includes(item.command[1])
              && ownsPortableLaunch(directory, name, item.command)) item.command = ["node", packagedServer];
            if (!samePath(path.resolve(directory, item.command[1]), packagedServer)) continue;
            serverPrefixes.push(sanitize(name) + "_");
            for (const tool of ["head_project_status", "head_tools_read", "head_tools_call"]) aliases.set(sanitize(name) + "_" + tool, tool);
          } catch { /* Unsupported config shape is not a user setup gate. */ }
        }
      },
      async "experimental.chat.system.transform"(input, output) {
        try {
          const system = output?.system;
          if (!Array.isArray(system) || !system.every(text => typeof text === "string")
            || !Object.isExtensible(system) || !Object.getOwnPropertyDescriptor(system, "length")?.writable) return;
          const previous = deliveries.get(system);
          const ownsSlot = previous && previous.index !== null && system[previous.index] === previous.text
            && Object.getOwnPropertyDescriptor(system, String(previous.index))?.writable;
          // Only our own slot may be refreshed. Other plugins' strings/order and
          // the caller's array stay intact. No last-Session or basis cache.
          const delivery = { index: ownsSlot ? previous.index : null, text: "", sessionID: input?.sessionID, reference: "" };
          deliveries.set(system, delivery);
          if (ownsSlot) system[delivery.index] = "";
          if (disposed || !contextSupported || !nativeId(input?.sessionID)) return;
          const session = await exactSession(input.sessionID);
          if (!session || disposed || !contextSupported || deliveries.get(system) !== delivery) return;
          if (![".head", ".lode"].some(name => fs.existsSync(path.join(directory, name, "project.json")))) return;
          let text, prepared;
          try {
            const adapter = createSessionHostAdapter({ runtime: "opencode", nativeSessionId: session.id, environment });
            text = startupProjection((await adapter.enter({ root: directory })), directory, "opencode");
            if (text.length > MAX_CONTEXT_CHARACTERS.opencode) throw new Error("Context exceeds its delivery bound.");
            prepared = prepareUserPromptReference({ root: directory, runtime: "opencode", nativeSessionId: session.id, environment,
              additionalContext: text, limit: MAX_CONTEXT_CHARACTERS.opencode });
            const reference = prepared?.text || (ownsSlot && previous.sessionID === session.id ? previous.reference : "") || "";
            delivery.reference = reference;
            text = appendUserPromptReference(text, reference, MAX_CONTEXT_CHARACTERS.opencode);
          } catch (error) {
            const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code)
              ? error.code : "HOST_CONTEXT_UNAVAILABLE";
            text = "Lode optional request context unavailable (" + code + "). Continue independent work; no default Session was substituted or recovery state written.";
          }
          if (disposed || !contextSupported || output.system !== system || deliveries.get(system) !== delivery
            || !sessionScope(session, input.sessionID)) return;
          let pending = null;
          try {
            activeSessionIds.add(session.id);
            registerIfMailbox(session);
            // Never session.prompt the session whose transform is running. That
            // call is the busy session and can hang this hook. Its inbox is
            // injected below; other sessions are delivered by the inbox watcher.
            pending = prepareOpenCodeInjection({ root: directory, session });
            if (pending?.text && Object.isExtensible(system)) Array.prototype.push.call(system, pending.text);
            else pending?.release();
            if (pending?.text && system.at(-1) === pending.text) pending.commit();
            else pending?.release();
          } catch { pending?.release(); }
          finally { activeSessionIds.delete(session.id); }
          if (delivery.index === null) {
            delivery.index = system.length;
            Array.prototype.push.call(system, text);
          } else {
            const descriptor = Object.getOwnPropertyDescriptor(system, String(delivery.index));
            if (!descriptor?.writable || system[delivery.index] !== delivery.text) return;
            system[delivery.index] = text;
          }
          delivery.text = text;
          if (prepared && output.system === system && system[delivery.index] === text
            && deliveries.get(system) === delivery && !disposed && contextSupported) acknowledgeUserPromptReference(prepared);
        } catch { /* Unsupported optional delivery never blocks the Host request. */ }
      },
      async event({ event }) {
        try { notePromptEvent(event); }
        catch { /* Prompt reference capture cannot block the host event. */ }
        if (!supportedEvents.has(event?.type) || !nativeId(event.id)) return;
        const eventType = event.type, eventId = event.id;
        const id = event.properties?.sessionID || event.properties?.info?.id;
        if (!nativeId(id)) return;
        // Deletion is delivered after the upstream record may have disappeared.
        // Capture only the actually delivered scope scalars, not its free-form
        // title/body. A missing get/status entry is never deletion evidence.
        const info = event.properties?.info;
        const deletedInfo = eventType === "session.deleted" && object(info)
          ? { id: info.id, projectID: info.projectID, directory: info.directory } : null;
        if (eventType === "session.deleted" && (!sessionScope(deletedInfo, id)
          || Object.hasOwn(event.properties, "sessionID") && event.properties.sessionID !== deletedInfo.id)) return;
        // Keep queued input allowlisted, not an entire message/status/error body.
        const status = ["busy", "retry", "idle"].includes(event.properties?.status?.type) ? event.properties.status.type : null;
        return enqueue(async () => {
          const session = eventType === "session.deleted" ? null : await exactSession(id);
          if (eventType === "session.deleted" ? !sessionScope(deletedInfo, id) : !session) return;
          if (session) registerIfMailbox(session);
          const observation = { kind: "event", event: eventType, phase: supportedEvents.get(eventType),
            requestId: null, source: null, reason: null, ...(status ? { nativeStatus: status } : {}) };
          await store.observe({ root: directory, caller: caller(id), observation, eventId });
        });
      },
      async "experimental.session.compacting"(input, output) {
        // Freeze only. Do not replace the host compaction prompt or its context.
        try {
          const caller = promptCaller(input?.sessionID);
          if (caller) freezeUserPromptReference(caller);
        } catch { /* The host compaction continues without this reference. */ }
        void output;
      },
      async "command.executed"(input) {
        try {
          const name = input?.name || input?.command;
          if (name !== "clear") return;
          const caller = promptCaller(input?.sessionID);
          if (caller) freezeUserPromptReference(caller);
        } catch { /* A missing clear signal does not block the command. */ }
      },
      async "tool.execute.before"(input, output) {
        try {
          const aliased = aliases.get(input?.tool);
          const prefixed = serverPrefixes.find(prefix => typeof input?.tool === "string" && input.tool.startsWith(prefix));
          const tool = aliased || (prefixed ? input.tool.slice(prefixed.length) : input?.tool);
          const semantic = resolveOperation(tool)?.semanticName || tool;
          const routed = ["head_tools_read", "head_tools_call"].includes(semantic);
          const inner = routed ? resolveOperation(output?.args?.name)?.semanticName : semantic;
          const targetArgs = routed ? output?.args?.arguments : output?.args;
          if (["head_conversation_list", "head_conversation_send"].includes(inner) && object(targetArgs) && nativeId(input?.sessionID)) {
            const session = await exactSession(input.sessionID);
            const ticket = session && writeOpenCodeCallerTicket({ root: directory, session, args: targetArgs, environment });
            if (ticket) {
              const descriptor = Object.getOwnPropertyDescriptor(targetArgs, "host_ticket");
              if (!descriptor || descriptor.writable !== false) targetArgs.host_ticket = ticket;
            }
          }
        } catch { /* A missing ticket fails closed in the tool instead of guessing a caller. */ }
        let decision;
        try {
          // Apply the shared policy to this actual Host call. No argument-keyed
          // ticket can leak a child's identity into a parent or sibling call.
          const prospectiveCaller = { runtime: "opencode", subagent: true, correlation: "awaited-native-before-hook" };
          if (disposed || !subagentWriteGuardEnabled(environment, { caller: prospectiveCaller })) return;
          const aliased = aliases.get(input?.tool);
          const prefixed = serverPrefixes.find(prefix => typeof input?.tool === "string" && input.tool.startsWith(prefix));
          const tool = aliased || (prefixed ? input.tool.slice(prefixed.length) : null);
          if (!tool || !nativeId(input?.sessionID)) return;
          // Unset default requires this actual awaited call ID. Explicit
          // enforce keeps its prior supported before-hook behavior.
          const explicitEnforce = environment?.LODE_SUBAGENT_WRITE_GUARD === "enforce";
          if (!explicitEnforce && !nativeId(input?.callID)) return;
          const raw = object(output?.args) ? output.args : null;
          if (!raw) return;
          const resolved = resolveOperation(tool);
          const routed = ["head_tools_read", "head_tools_call"].includes(resolved?.semanticName || tool);
          const inner = routed ? raw.name : tool;
          const args = routed ? raw.arguments : raw;
          const semantic = resolveOperation(inner)?.semanticName;
          if (!semantic || !object(args)) return;
          const { catalogTools } = await import("./mcp-server.mjs");
          const selected = catalogTools.find(item => resolveOperation(item.name)?.semanticName === semantic);
          if (!selected || selected.annotations?.readOnlyHint === true) return;
          const session = await exactSession(input.sessionID);
          if (typeof session?.parentID !== "string" || !session.parentID || !explicitEnforce && !nativeId(session.parentID)) return;
          decision = assessSubagentStateWrite({ caller: prospectiveCaller, readOnly: selected.annotations?.readOnlyHint === true });
        } catch { /* Unavailable optional Host evidence does not gate independent work. */ }
        // The real Host awaits this hook before execute. Never swallow the
        // intentional policy rejection together with optional lookup failures.
        if (decision?.allowed === false) throw Object.assign(new Error(decision.message), { code: decision.code });
      },
      async "tool.execute.after"(input, output) {
        try {
          const tool = aliases.get(input?.tool), routed = ["head_tools_read", "head_tools_call"].includes(tool);
          const name = routed ? input.args?.name : tool, args = routed ? input.args?.arguments : input?.args;
          if (disposed || name !== "head_project_status" || !nativeId(input.sessionID) || !nativeId(input.callID)
            || !object(args) || typeof args.project_root !== "string" || !samePath(args.project_root, directory)
            || !object(output) || output.isError || !object(output.structuredContent) || !Array.isArray(output.content)
            || !Object.isExtensible(output) || !["content", "structuredContent"].every(key => {
              const d = Object.getOwnPropertyDescriptor(output, key); return d?.writable === true && !d.get && !d.set;
            })) return;
          if (!await exactSession(input.sessionID)) return;
          const projection = await projectNativeObservations({ root: directory, caller: caller(input.sessionID), environment })
            || { authorityPlane: "P5", scope: "native-caller-not-logical-session-execution", caller: caller(input.sessionID),
              observations: [], omitted: 0, persisted: false, recoveryAuthority: false, instructionAuthority: false };
          // One supplied map, O(A) payload, not an exact-ID status API. Absence
          // means no non-idle entry was returned, not native/process/work end.
          const map = await bounded(signal => client.session.status({ query: { directory }, signal }));
          const state = object(map) && Object.hasOwn(map, input.sessionID) ? map[input.sessionID]?.type : null;
          projection.currentObservation = { state: ["busy", "retry", "idle"].includes(state) ? state
            : object(map) && !Object.hasOwn(map, input.sessionID) ? "no-non-idle-entry" : "unknown",
          checkedAt: new Date().toISOString(), scope: "supplied-opencode-session-at-check-not-task-state" };
          const next = appendNativeStatus(output, projection);
          if (next === output) return;
          // The real Host ignores callback return values. Commit the two prepared
          // optional additions to the actual raw result; preserve canonical items.
          output.content = next.content;
          output.structuredContent = next.structuredContent;
        } catch { /* Unsupported/malformed/optional API errors leave Core untouched. */ }
      },
      async dispose() { disposed = true; try { watcher?.close(); } catch { /* Closing the inbox watch is optional. */ } aliases.clear(); serverPrefixes = []; userMessages.clear(); deliveries = new WeakMap(); await queue; },
    };
  },
};
