import crypto from "node:crypto";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lode-artifact-composition.mjs";
import { resolveOperation } from "./lode-operation-contract.mjs";
import { sessionCallRequiresBinding } from "./session-routing.mjs";

export const SESSION_HOST_REQUEST_HELPER = publicToolName("head_session_host_request_prepare");
const namespaces = () => [ARTIFACT_COMPOSITION.serverName, `plugin_${ARTIFACT_COMPOSITION.pluginName}_${ARTIFACT_COMPOSITION.serverName}`];
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build/verification consumes the actual catalog annotations, including finite
// supported aliases. Do not maintain a second list of protected tool names.
export function claudeNativeHookMatchers(catalog) {
  const names = new Set();
  for (const tool of catalog) {
    const operation = resolveOperation(tool.name);
    if (!operation || operation.semanticName === "head_session_host_request_prepare") continue;
    if (operation.router || sessionCallRequiresBinding(tool.name) || tool.annotations?.readOnlyHint !== true) {
      names.add(operation.canonicalName); names.add(operation.legacyName);
    }
  }
  const pattern = [...names].sort().map(escapeRegex).join("|");
  return namespaces().map(server => `^mcp__${escapeRegex(server)}__(${pattern})$`);
}

export function parseClaudeNativeToolName(outer) {
  if (typeof outer !== "string") return null;
  for (const server of namespaces()) {
    const prefix = `mcp__${server}__`;
    if (!outer.startsWith(prefix)) continue;
    const name = outer.slice(prefix.length), operation = resolveOperation(name);
    if (operation && operation.semanticName !== "head_session_host_request_prepare") return { name, server };
  }
  return null;
}
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const hostRequestDigest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const fail = code => { throw Object.assign(new Error("Native request correlation is unavailable."), { code }); };

// P5 transient correlation, NOT a replay/approval/effect ledger. Expiry/capacity
// can lose optional caller metadata, never authorize/cancel/replay a Core effect.
export function createSessionHostRequestRegistry({ now = Date.now, ttlMs = 600_000, maxPending = 1024 } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error("Invalid Host cache bounds.");
  const pending = new Map(), spent = new Map();
  let disposed = false;
  function sweep() {
    const time = now();
    for (const [key, value] of pending) if (!value.active && value.expiresAt <= time) pending.delete(key);
    for (const [key, timeLimit] of spent) if (timeLimit <= time) spent.delete(key);
  }
  return Object.freeze({
    prepare({ key, caller, name, arguments: args }) {
      if (disposed) fail("HOST_REQUEST_REGISTRY_DISPOSED");
      sweep();
      if (spent.has(key)) fail("HOST_REQUEST_ALREADY_CONSUMED");
      const digest = hostRequestDigest(args), callerKey = canonical(caller), prior = pending.get(key);
      if (prior) {
        if (prior.active) fail("HOST_REQUEST_ALREADY_ACTIVE");
        if (prior.invalid || prior.name !== name || prior.digest !== digest || prior.callerKey !== callerKey) {
          prior.invalid = true; fail("HOST_REQUEST_DIVERGENT");
        }
        return; // exact pending retry does not extend its lifetime
      }
      if (pending.size >= maxPending) fail("HOST_REQUEST_CAPACITY");
      pending.set(key, { caller: Object.freeze({ ...caller }), callerKey, name, digest, active: false, invalid: false, expiresAt: now() + ttlMs });
    },
    claim({ key, name, arguments: args }) {
      if (disposed) fail("HOST_REQUEST_REGISTRY_DISPOSED");
      sweep();
      const entry = pending.get(key);
      if (!entry || entry.active || entry.invalid || entry.name !== name || entry.digest !== hostRequestDigest(args)) fail("HOST_REQUEST_CORRELATION_MISSING");
      entry.active = true;
      let released = false;
      return { caller: entry.caller, release() {
        if (released) return;
        released = true;
        if (pending.get(key) === entry) pending.delete(key);
        if (!disposed) {
          spent.set(key, now() + ttlMs);
          while (spent.size > maxPending) spent.delete(spent.keys().next().value);
        }
      } };
    },
    describe() { sweep(); return { authorityPlane: "P5", pending: pending.size, active: [...pending.values()].filter(entry => entry.active).length,
      spent: spent.size, ttlMs, maxPending, disposed, durableReplayProtection: false, recoveryAuthority: false }; },
    dispose() { disposed = true; pending.clear(); spent.clear(); },
  });
}
