// P5 developer diagnostics, not an authorization or an enforcement capability.
// Exact Codex 0.153.4 source: app-server/request_processors/thread_processor.rs,
// thread_goal_processor.rs; core/session/mod.rs at the commit below.
export const CODEX_FORK_AUDITED_SOURCE = "3d2ee51ca2d5db578f328aa75e20aa22c0197c9a";
export const CODEX_FORK_AUDITED_EXECUTABLE = "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b";

export function codexInstalledForkRequestError(params, sourceHistoryMode = "unknown") {
  if (params.permissions != null && params.sandbox != null) return "`permissions` cannot be combined with `sandbox`";
  if (params.lastTurnId != null && params.beforeTurnId != null) return "`beforeTurnId` cannot be combined with `lastTurnId`";
  if (params.ephemeral === true && params.deferGoalContinuation === true) return "`deferGoalContinuation` cannot be combined with `ephemeral`";
  if (sourceHistoryMode === "paginated" && params.ephemeral === true && params.excludeTurns !== true) return "ephemeral paginated thread/fork requires `excludeTurns: true`";
  return null;
}

// A local rejection of known invalid combinations, never a claim that all
// other fields, effective policy, source availability or permissions are valid.
export function assertCodexInstalledForkRequest(params, sourceHistoryMode) {
  const message = codexInstalledForkRequestError(params, sourceHistoryMode);
  if (message) throw Object.assign(new Error(message), { code: "CODEX_NATIVE_FORK_API_CONFLICT" });
}

export function inspectCodexNativeForkCandidate({ forkParams, sourceHistoryMode = "unknown", goalsEnabled,
  requiresChildHistoryRead = false, requiresGoalReadOrClear = false } = {}) {
  if (!forkParams || !["legacy", "paginated", "unknown"].includes(sourceHistoryMode)
    || ![true, false, undefined].includes(goalsEnabled)) throw new TypeError("Invalid native fork candidate");
  const conflicts = [];
  const requestError = codexInstalledForkRequestError(forkParams, sourceHistoryMode);
  if (requestError) conflicts.push({ code: "fork-request-rejected", reason: requestError });
  if (requiresChildHistoryRead && forkParams.ephemeral === true) conflicts.push({ code: "ephemeral-history-unavailable",
    reason: "thread/read includeTurns and thread/turns/list reject ephemeral children; fork response history is not a subsequent readback." });
  if (requiresGoalReadOrClear && goalsEnabled === false) conflicts.push({ code: "goals-disabled-api-unavailable",
    reason: "thread/goal/get and thread/goal/clear return an error when goals are disabled, not a null goal." });
  if (requiresGoalReadOrClear && forkParams.ephemeral === true) conflicts.push({ code: "ephemeral-goals-unavailable",
    reason: "Goal access requires a materialized thread even when the goals feature is enabled." });
  return { kind: "CodexNativeForkCandidateDiagnostic", sourceCommit: CODEX_FORK_AUDITED_SOURCE,
    diagnosticOnly: true, knownApiConflicts: conflicts, apiCandidate: conflicts.length === 0,
    enforcementVerified: false, capabilityIssued: false, recoveryAuthority: false };
}

// This is the existing 0.2 native code-worker sequence, not a new narrower
// proposal mode. Removing defer alone, enabling goals, or making the child
// durable would neither preserve this sequence nor prove its tool boundary.
export function inspectCurrentCodexNativeForkCompatibility() {
  return inspectCodexNativeForkCandidate({ forkParams: { ephemeral: true, excludeTurns: false, deferGoalContinuation: true },
    sourceHistoryMode: "legacy", goalsEnabled: false, requiresChildHistoryRead: true, requiresGoalReadOrClear: true });
}
