#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { coreEntryGuidance } from "./lib/session/lode-entry-guidance.mjs";
import { rootSpellingRetryPending, withOnDiskSpellingRetry, withRecordedCwd } from "./lib/storage/project-root-spelling.mjs";
// Node >=24 supports synchronous ESM module loading. Load readers lazily so an
// End-only Hook does not import recovery/prompt readers; Start awaits storage I/O.
const require = createRequire(import.meta.url);

// A read-only command Hook renderer. The outer driver may retain P5 observations
// and exact paired-clear carrier continuity; neither path writes P2 direction.
export async function sessionStartContext({ runtime, event, environment = process.env } = {}) {
  event = withRecordedCwd(event);
  // A cwd that differs only in directory-name case is retried with the
  // recorded spelling after its Project was not found (no read when found).
  if (typeof event?.cwd !== "string") return await spelledSessionStartContext({ runtime, event, environment });
  return await withOnDiskSpellingRetry(event.cwd, (cwd) =>
    spelledSessionStartContext({ runtime, event: cwd === event.cwd ? event : { ...event, cwd }, environment }),
  );
}

async function spelledSessionStartContext({ runtime, event, environment }) {
  if (
    !["codex", "claude"].includes(runtime) ||
    event?.hook_event_name !== "SessionStart" ||
    !["startup", "resume", "clear", "compact", "fork"].includes(event.source) ||
    typeof event.cwd !== "string" ||
    typeof event.session_id !== "string"
  )
    return {};
  if (![".head", ".lode"].some((directory) => fs.existsSync(path.join(event.cwd, directory, "project.json")))) return {};
  // Codex's per-tool parent ID is ambiguous. Never use an unexpected agent hint
  // to select/write the parent; stock tool hooks are intentionally not wired.
  if (runtime === "codex" && event.agent_id) return {};
  let entry;
  try {
    const { createSessionHostAdapter } = require("./lib/session/session-host-adapter.mjs");
    const adapter = createSessionHostAdapter({
      runtime,
      nativeSessionId: event.session_id,
      agentId: runtime === "claude" ? event.agent_id || null : null,
      environment,
    });
    entry = await adapter.enter({ root: event.cwd });
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code) ? error.code : "HOST_CONTEXT_UNAVAILABLE";
    // A folder holding a Lode Project recorded for another root is an existing
    // Project, not an uninitialized one: say so, matching the status command.
    // This read adopts nothing; it only names the explicit resume.
    let relocation = null;
    if (code === "NOT_INITIALIZED" && typeof event?.cwd === "string") {
      try {
        relocation = require("./lib/session/compaction-lifecycle.mjs").projectRelocationHint(event.cwd);
      } catch {
        relocation = null;
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: JSON.stringify({
          status: "host_context_unavailable",
          reasonCode: relocation ? relocation.reasonCode : code,
          ...(relocation ? { projectLocation: relocation.projectLocation, nextAction: relocation.nextAction } : {}),
          coreGuidance: coreEntryGuidance(),
          recoveryContext: "unknown",
          sessionSelection: "not-inferred",
          ordinaryWorkBlocked: false,
          persisted: false,
        }),
      },
    };
  }
  const { startupProjection } = require("./lib/session/session-host-context-projection.mjs");
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
  const { captureUserPrompt, captureVisibleAssistantReference, freezeUserPromptReference } = require("./lib/session/user-prompt-reference.mjs");
  if (event.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string") {
    captureUserPrompt({
      root: event.cwd,
      ...caller,
      text: event.prompt,
      messageId: runtime === "codex" && typeof event.turn_id === "string" ? event.turn_id : null,
      environment,
    });
  }
  if (event.hook_event_name === "Stop")
    captureVisibleAssistantReference({ root: event.cwd, ...caller, text: event.last_assistant_message, turnId: event.turn_id, environment });
  if (event.hook_event_name === "PreCompact") freezeUserPromptReference({ root: event.cwd, ...caller, environment });
}

// Mail is claimed only while the hook is within this many milliseconds of its
// start, so claiming, writing the output and committing finish well inside the
// Stop and UserPromptSubmit Hook timeout (hooks/claude.json, hooks/codex.json).
// Mail not claimed by then stays queued for the next Stop or prompt. Only the
// real hook process (main) sets this deadline; an in-process caller passes its
// own pickupDeadlineAt, and null means no deadline.
export const MAIL_PICKUP_BUDGET_MS = 6000;

export async function runSessionHostHook({
  runtime,
  event,
  environment = process.env,
  observeOnly = false,
  deliver,
  processObserver = null,
  deadlineAt = null,
  pickupDeadlineAt = null,
} = {}) {
  // A Host cwd that differs from the recorded Project root only in drive-letter
  // case reaches that Project (Windows); every hook path below reads event.cwd.
  event = withRecordedCwd(event);
  const options = { runtime, environment, observeOnly, deliver, processObserver, deadlineAt, pickupDeadlineAt };
  // A cwd that differs only in directory-name case is retried with the
  // recorded spelling after its Project was not found (no read when found).
  if (typeof event?.cwd !== "string") return await runSpelledSessionHostHook({ ...options, event });
  return await withOnDiskSpellingRetry(event.cwd, (cwd) => runSpelledSessionHostHook({ ...options, event: cwd === event.cwd ? event : { ...event, cwd } }));
}

async function runSpelledSessionHostHook({ runtime, event, environment, observeOnly, deliver, processObserver, deadlineAt, pickupDeadlineAt }) {
  const startedAt = Date.now();
  const promptDeadlineAt = Math.min(deadlineAt ?? Infinity, startedAt + 10_000);
  let nativeOutcome, observing;
  // A Claude prompt's process lookup is an independent child process: once it
  // has its whole input (the synchronous capture would otherwise hold that
  // input back), the prompt capture runs while it works, and the observation
  // is published after the capture with the same content. Nothing in between
  // reads it. SessionStart and the clear transitions keep the old order.
  const overlap = runtime === "claude" && event?.hook_event_name === "UserPromptSubmit";
  try {
    const { observeNativeHook } = await import("./lib/session/native-session-observations.mjs");
    let lookupStarted;
    const started = new Promise((resolve) => (lookupStarted = resolve));
    const probe = overlap ? processObserver || (await import("./lib/session/native-session-process.mjs")).observeClaudeProcess : processObserver;
    observing = observeNativeHook({
      runtime,
      event,
      environment,
      processObserver: overlap
        ? (options) => {
            const lookup = probe({
              ...options,
              onProcess(record) {
                if (["input-written", "closed"].includes(record?.event)) lookupStarted();
              },
            });
            Promise.resolve(lookup).then(lookupStarted, lookupStarted);
            return lookup;
          }
        : processObserver,
      deadlineAt,
    }).catch(() => undefined);
    if (overlap) await Promise.race([started, observing]);
    else nativeOutcome = await observing;
  } catch {
    /* Observations cannot block native flow or existing recovery. */
  }
  try {
    noteNativePrompt(runtime, event, environment);
  } catch {
    /* A missing prompt reference never blocks the host. */
  }
  if (overlap) nativeOutcome = await observing;
  let promptOperation, referenceTransfer;
  if (!observeOnly && event?.hook_event_name === "SessionStart" && ["clear", "compact"].includes(event.source))
    try {
      const helpers = require("./lib/session/user-prompt-reference.mjs");
      promptOperation = helpers.createUserPromptReferenceOperation({ deadlineAt: promptDeadlineAt });
      if (event.source === "clear" && nativeOutcome?.clearHandoff)
        referenceTransfer = helpers.transferNativeClearPromptReference({
          handoff: nativeOutcome.clearHandoff,
          root: event.cwd,
          caller: promptCaller(runtime, event),
          environment,
          deadlineAt: promptDeadlineAt,
          operation: promptOperation,
        });
    } catch {
      /* Optional reference work cannot undo an existing Session link. */
    }
  let context = observeOnly ? {} : await sessionStartContext({ runtime, event, environment }),
    prepared;
  if (context.hookSpecificOutput?.additionalContext && ["compact", "clear"].includes(event?.source))
    try {
      const { prepareUserPromptReference, appendUserPromptReference } = require("./lib/session/user-prompt-reference.mjs");
      const { MAX_CONTEXT_CHARACTERS } = require("./lib/session/session-host-context-projection.mjs");
      const caller = promptCaller(runtime, event);
      prepared =
        caller &&
        prepareUserPromptReference({
          root: event.cwd,
          ...caller,
          environment,
          force: true,
          additionalContext: context.hookSpecificOutput.additionalContext,
          limit: MAX_CONTEXT_CHARACTERS[runtime] || 0,
          operation: promptOperation,
        });
      if (prepared)
        context = {
          hookSpecificOutput: {
            ...context.hookSpecificOutput,
            additionalContext: appendUserPromptReference(context.hookSpecificOutput.additionalContext, prepared.text, MAX_CONTEXT_CHARACTERS[runtime] || 0),
          },
        };
    } catch {
      /* Preserve primary context and the undelivered reference. */
    }
  // The Project was not found under this cwd spelling and the entry retries
  // with the recorded one: deliver nothing from this attempt.
  if (rootSpellingRetryPending()) return context;
  // Direct callers receive a constructed local object. Command Hooks use the
  // stdout callback instead. Neither boundary proves Host or model reception.
  let injection = null;
  try {
    const messaging = require("./lib/session/conversation-messaging.mjs");
    messaging.registerHookPresence({ runtime, event, environment, initialize: !observeOnly });
    if (event?.hook_event_name === "UserPromptSubmit")
      injection = messaging.prepareHookInjection({ runtime, event, environment, deadlineAt: pickupDeadlineAt });
    // Stop hands the caller's own queued mail over and continues the turn. It
    // registers nothing and sets nothing up, so --observe-only keeps its meaning.
    if (event?.hook_event_name === "Stop") {
      injection = messaging.prepareStopInjection({ runtime, event, environment, deadlineAt: pickupDeadlineAt });
      const output = injection?.text ? messaging.stopContinuationOutput(runtime, injection.text) : null;
      if (injection && !output) {
        injection.release();
        injection = null;
      }
      if (output) context = { ...context, ...output };
    }
  } catch {
    try {
      injection?.release();
    } catch {
      /* The claim stays held; recovery keeps it unknown. */
    }
    injection = null;
  }
  if (injection?.text && event?.hook_event_name !== "Stop") {
    const previous = context.hookSpecificOutput?.additionalContext || "";
    context = {
      ...context,
      hookSpecificOutput: {
        hookEventName: event.hook_event_name,
        ...(context.hookSpecificOutput || {}),
        additionalContext: previous ? previous + "\n" + injection.text : injection.text,
      },
    };
  }
  try {
    if (deliver) await deliver(context);
  } catch (error) {
    if (injection) injection.release();
    throw error;
  }
  if (injection) injection.commit();
  if (prepared) require("./lib/session/user-prompt-reference.mjs").acknowledgeUserPromptReference(prepared);
  if (referenceTransfer) Object.defineProperty(context, "referenceTransfer", { value: referenceTransfer });
  return context;
}

export function writeSessionHostOutput(output, sink) {
  const text = JSON.stringify(output) + "\n";
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    sink.once("error", onError);
    try {
      // false means backpressure. The callback, not the boolean, determines
      // whether these bytes reached the local stream's completion boundary.
      sink.write(text, (error) => {
        if (error) reject(error);
        else {
          sink.removeListener("error", onError);
          resolve();
        }
      });
    } catch (error) {
      sink.removeListener("error", onError);
      reject(error);
    }
  });
}

async function main() {
  const args = process.argv.slice(2),
    index = args.indexOf("--runtime");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      await writeSessionHostOutput({}, process.stdout).catch(() => {});
      return;
    }
    chunks.push(chunk);
  }
  let event;
  try {
    event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await writeSessionHostOutput({}, process.stdout).catch(() => {});
    return;
  }
  const runtime = args[index + 1],
    clearTransition =
      runtime === "claude" &&
      ((event.hook_event_name === "SessionEnd" && event.reason === "clear") || (event.hook_event_name === "SessionStart" && event.source === "clear"));
  try {
    await runSessionHostHook({
      runtime,
      event,
      observeOnly: args.includes("--observe-only"),
      // Existing Host limits: End 1s; Start 10s. The optional clear query
      // has its own <=1s bound inside observeNativeHook; it does not cap rendering.
      ...(clearTransition ? { deadlineAt: Math.floor(performance.timeOrigin) + (event.hook_event_name === "SessionEnd" ? 1000 : 10_000) } : {}),
      // Counted from this process's start, so Node start-up and the prompt
      // reference work before the pick-up are inside the budget.
      pickupDeadlineAt: Math.floor(performance.timeOrigin) + MAIL_PICKUP_BUDGET_MS,
      deliver: (output) => writeSessionHostOutput(output, process.stdout),
    });
  } catch {
    /* A failed local stream leaves its reference available for retry. */
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
