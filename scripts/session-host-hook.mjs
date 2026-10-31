#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { coreEntryGuidance } from "./lib/lode-entry-guidance.mjs";
// Node >=24 supports synchronous ESM module loading. Load readers lazily so an
// End-only Hook does not import recovery/prompt readers; Start awaits storage I/O.
const require = createRequire(import.meta.url);

// A read-only command Hook renderer. The outer driver may retain P5 observations
// and exact paired-clear carrier continuity; neither path writes P2 direction.
export async function sessionStartContext({ runtime, event, environment = process.env } = {}) {
  if (!["codex", "claude"].includes(runtime) || event?.hook_event_name !== "SessionStart"
    || !["startup", "resume", "clear", "compact", "fork"].includes(event.source)
    || typeof event.cwd !== "string" || typeof event.session_id !== "string") return {};
  if (![".head", ".lode"].some(directory => fs.existsSync(path.join(event.cwd, directory, "project.json")))) return {};
  // Codex's per-tool parent ID is ambiguous. Never use an unexpected agent hint
  // to select/write the parent; stock tool hooks are intentionally not wired.
  if (runtime === "codex" && event.agent_id) return {};
  let entry;
  try {
    const { createSessionHostAdapter } = require("./lib/session-host-adapter.mjs");
    const adapter = createSessionHostAdapter({ runtime, nativeSessionId: event.session_id,
      agentId: runtime === "claude" ? event.agent_id || null : null, environment });
    entry = (await adapter.enter({ root: event.cwd }));
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code)
      ? error.code : "HOST_CONTEXT_UNAVAILABLE";
    return { hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: JSON.stringify({ status: "host_context_unavailable", reasonCode: code,
        coreGuidance: coreEntryGuidance(), recoveryContext: "unknown", sessionSelection: "not-inferred",
        ordinaryWorkBlocked: false, persisted: false }) } };
  }
  const { startupProjection } = require("./lib/session-host-context-projection.mjs");
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: startupProjection(entry, event.cwd, runtime) } };
}

function promptCaller(runtime, event) {
  if (!["codex", "claude"].includes(runtime) || typeof event?.cwd !== "string" || typeof event?.session_id !== "string") return null;
  if (runtime === "codex" && event.agent_id) return { runtime, nativeSessionId: event.agent_id, agentId: null };
  return { runtime, nativeSessionId: event.session_id, agentId: runtime === "claude" ? event.agent_id || null : null };
}

// Prompt text stays out of native observation snapshots. PreCompact only freezes
// the reference; it must not return a hook decision that blocks compaction.
function noteNativePrompt(runtime, event, environment) {
  if (!["UserPromptSubmit", "Stop", "PreCompact"].includes(event?.hook_event_name)) return;
  const caller = promptCaller(runtime, event);
  if (!caller) return;
  const { captureUserPrompt, captureVisibleAssistantReference, freezeUserPromptReference } = require("./lib/user-prompt-reference.mjs");
  if (event.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string") {
    captureUserPrompt({ root: event.cwd, ...caller, text: event.prompt,
      messageId: runtime === "codex" && typeof event.turn_id === "string" ? event.turn_id : null, environment });
  }
  if (event.hook_event_name === "Stop") captureVisibleAssistantReference({ root: event.cwd, ...caller,
    text: event.last_assistant_message, turnId: event.turn_id, environment });
  if (event.hook_event_name === "PreCompact") freezeUserPromptReference({ root: event.cwd, ...caller, environment });
}

export async function runSessionHostHook({ runtime, event, environment = process.env, observeOnly = false, deliver,
  processObserver = null, deadlineAt = null } = {}) {
  const startedAt = Date.now();
  const promptDeadlineAt = Math.min(deadlineAt ?? Infinity, startedAt + 10_000);
  let nativeOutcome;
  try {
    const { observeNativeHook } = await import("./lib/native-session-observations.mjs");
    nativeOutcome = await observeNativeHook({ runtime, event, environment, processObserver, deadlineAt });
  } catch { /* Observations cannot block native flow or existing recovery. */ }
  try { noteNativePrompt(runtime, event, environment); }
  catch { /* A missing prompt reference never blocks the host. */ }
  let promptOperation, referenceTransfer;
  if (!observeOnly && event?.hook_event_name === "SessionStart" && ["clear", "compact"].includes(event.source)) try {
    const helpers = require("./lib/user-prompt-reference.mjs");
    promptOperation = helpers.createUserPromptReferenceOperation({ deadlineAt: promptDeadlineAt });
    if (event.source === "clear" && nativeOutcome?.clearHandoff) referenceTransfer = helpers.transferNativeClearPromptReference({
      handoff: nativeOutcome.clearHandoff, root: event.cwd, caller: promptCaller(runtime, event), environment,
      deadlineAt: promptDeadlineAt, operation: promptOperation });
  } catch { /* Optional reference work cannot undo an existing Session link. */ }
  let context = observeOnly ? {} : (await sessionStartContext({ runtime, event, environment })), prepared;
  if (context.hookSpecificOutput?.additionalContext && ["compact", "clear"].includes(event?.source)) try {
    const { prepareUserPromptReference, appendUserPromptReference } = require("./lib/user-prompt-reference.mjs");
    const { MAX_CONTEXT_CHARACTERS } = require("./lib/session-host-context-projection.mjs");
    const caller = promptCaller(runtime, event);
    prepared = caller && prepareUserPromptReference({ root: event.cwd, ...caller, environment, force: true,
      additionalContext: context.hookSpecificOutput.additionalContext, limit: MAX_CONTEXT_CHARACTERS[runtime] || 0, operation: promptOperation });
    if (prepared) context = { hookSpecificOutput: { ...context.hookSpecificOutput,
      additionalContext: appendUserPromptReference(context.hookSpecificOutput.additionalContext, prepared.text, MAX_CONTEXT_CHARACTERS[runtime] || 0) } };
  } catch { /* Preserve primary context and the undelivered reference. */ }
  // Direct callers receive a constructed local object. Command Hooks use the
  // stdout callback instead. Neither boundary proves Host or model reception.
  let injection = null;
  try {
    const messaging = require("./lib/conversation-messaging.mjs");
    messaging.registerHookPresence({ runtime, event, environment });
    if (event?.hook_event_name === "UserPromptSubmit") injection = messaging.prepareHookInjection({ runtime, event, environment });
  } catch { injection = null; }
  if (injection?.text) {
    const previous = context.hookSpecificOutput?.additionalContext || "";
    context = { ...context, hookSpecificOutput: { hookEventName: event.hook_event_name, ...(context.hookSpecificOutput || {}),
      additionalContext: previous ? previous + "\n" + injection.text : injection.text } };
  }
  try {
    if (deliver) await deliver(context);
  } catch (error) {
    if (injection) injection.release();
    throw error;
  }
  if (injection) injection.commit();
  if (prepared) require("./lib/user-prompt-reference.mjs").acknowledgeUserPromptReference(prepared);
  if (referenceTransfer) Object.defineProperty(context, "referenceTransfer", { value: referenceTransfer });
  return context;
}

export function writeSessionHostOutput(output, sink) {
  const text = JSON.stringify(output) + "\n";
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    sink.once("error", onError);
    try {
      // false means backpressure. The callback, not the boolean, determines
      // whether these bytes reached the local stream's completion boundary.
      sink.write(text, error => {
        if (error) reject(error);
        else { sink.removeListener("error", onError); resolve(); }
      });
    } catch (error) { sink.removeListener("error", onError); reject(error); }
  });
}

async function main() {
  const args = process.argv.slice(2), index = args.indexOf("--runtime");
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) { await writeSessionHostOutput({}, process.stdout).catch(() => {}); return; }
    chunks.push(chunk);
  }
  let event;
  try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { await writeSessionHostOutput({}, process.stdout).catch(() => {}); return; }
  const runtime = args[index + 1], clearTransition = runtime === "claude" && (event.hook_event_name === "SessionEnd" && event.reason === "clear"
    || event.hook_event_name === "SessionStart" && event.source === "clear");
  try { await runSessionHostHook({ runtime, event, observeOnly: args.includes("--observe-only"),
    // Existing Host limits: End 1s; Start 10s. The optional clear query
    // has its own <=1s bound inside observeNativeHook; it does not cap rendering.
    ...(clearTransition ? { deadlineAt: Math.floor(performance.timeOrigin) + (event.hook_event_name === "SessionEnd" ? 1000 : 10_000) } : {}),
    deliver: output => writeSessionHostOutput(output, process.stdout) }); }
  catch { /* A failed local stream leaves its reference available for retry. */ }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
