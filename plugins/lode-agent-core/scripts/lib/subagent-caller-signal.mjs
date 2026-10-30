import { createNativeObservationStore } from "./native-session-observations.mjs";

// Optional verified Codex P5 observation only. OpenCode enforces the same policy
// in its exact before-hook, never through an argument-matched shared ticket.
export function recordedSubagentCaller({ root, runtime, nativeSessionId, environment = process.env } = {}) {
  if (runtime !== "codex" || typeof nativeSessionId !== "string" || !nativeSessionId) return false;
  try {
    const snapshot = createNativeObservationStore({ environment }).read({ root, caller: { runtime, nativeSessionId, agentId: null } });
    return Boolean(snapshot?.rows?.some(row => row.observation?.event === "SubagentStart" || row.observation?.phase === "child-start-observed"));
  } catch { return false; }
}
