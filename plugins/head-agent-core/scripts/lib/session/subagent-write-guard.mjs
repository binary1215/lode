// Optional Host ingress policy, not malicious-client isolation. Unset protects
// exact-correlated Claude and OpenCode child writes and a detected Codex
// sub-conversation (session and thread differ, or the host marks the child).
// Explicit off is the opt-out. Unproven callers stay off.
export const SUBAGENT_WRITE_GUARD_ENV = "LODE_SUBAGENT_WRITE_GUARD";
export const SUBAGENT_STATE_WRITE_REJECTED = "SUBAGENT_STATE_WRITE_REJECTED";
export const SUBAGENT_WRITE_GUARD_INVALID = "SUBAGENT_WRITE_GUARD_INVALID";

// Environment diagnosis alone cannot assert exact native caller provenance.
// The implicit default is resolved per request by the function below.
export function diagnoseSubagentWriteGuard(environment = process.env) {
  const value = environment?.[SUBAGENT_WRITE_GUARD_ENV];
  const enabled = value === "enforce";
  const valid = value === undefined || value === null || value === "" || value === "off" || enabled;
  return {
    enabled,
    valid,
    ...(valid
      ? {}
      : {
          code: SUBAGENT_WRITE_GUARD_INVALID,
          message: `${SUBAGENT_WRITE_GUARD_INVALID}: ${SUBAGENT_WRITE_GUARD_ENV} must be exactly "enforce" or "off". Unset protects exact Claude/OpenCode child calls and detected Codex sub-conversations. Invalid configuration was ignored; subagent write protection is OFF. Ordinary work is not blocked.`,
        }),
  };
}

// Remember at most the last invalid value, not an unbounded set of environment
// contents. Do not print the value: configuration can contain accidental secrets.
let lastInvalidValue;
export function subagentWriteGuardEnabled(environment = process.env, { caller = null, warn = (message) => process.stderr.write(message + "\n") } = {}) {
  const diagnostic = diagnoseSubagentWriteGuard(environment);
  if (!diagnostic.valid) {
    const value = environment?.[SUBAGENT_WRITE_GUARD_ENV];
    if (value !== lastInvalidValue) {
      lastInvalidValue = value;
      try {
        warn(diagnostic.message);
      } catch {
        /* Diagnostics never gate work. */
      }
    }
  } else lastInvalidValue = undefined;
  if (diagnostic.enabled || !diagnostic.valid) return diagnostic.enabled;
  const value = environment?.[SUBAGENT_WRITE_GUARD_ENV];
  if (!(value === undefined || value === null || value === "") || caller?.subagent !== true) return false;
  return (
    (caller.runtime === "claude" && caller.correlation === "exact-native-tool-use") ||
    (caller.runtime === "opencode" && caller.correlation === "awaited-native-before-hook") ||
    (caller.runtime === "codex" && caller.correlation === "codex-subconversation")
  );
}

export function assessSubagentStateWrite({ caller = null, readOnly = true } = {}) {
  if (readOnly || caller?.subagent !== true) return { allowed: true };
  return {
    allowed: false,
    code: SUBAGENT_STATE_WRITE_REJECTED,
    message:
      SUBAGENT_STATE_WRITE_REJECTED +
      ": a verified subagent caller cannot mutate protected Lode state (canon, checkpoints, lineage, reviews, or other non-read-only tools). Read tools and independent source work remain available. The parent records protected state; explicit LODE_SUBAGENT_WRITE_GUARD=off disables this optional Host policy.",
  };
}
