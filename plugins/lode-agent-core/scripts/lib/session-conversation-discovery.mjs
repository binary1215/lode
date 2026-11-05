import { createSessionHostAdapter } from "./session-host-adapter.mjs";
import { SESSION_WORK_DEFAULT_CHARACTERS } from "./session-work-evidence-original.mjs";
import { formatMcpToolContent } from "./cli-presentation.mjs";

const validId = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
const reason = error => /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.code || "") ? error.code : "CONVERSATION_BINDING_UNAVAILABLE";
const same = (a, b) => a.status === b.status && a.sessionId === b.sessionId
  && a.revision === b.revision && a.bindingDigest === b.bindingDigest;

// P4 presentation only: account for the existing MCP text/structured duplication
// and JSON escaping, without changing or measuring the primary Session list.
// One extra comma conservatively covers a nonempty primary structured object.
const responseBytes = value => Buffer.byteLength(JSON.stringify({
  content: [{ type: "text", text: formatMcpToolContent("head_session_list", value) }], structuredContent: value,
}));
const emptyResponseBytes = responseBytes({});
const additionalResponseBytes = projection => responseBytes({ conversationDiscovery: projection }) - emptyResponseBytes + 1;

// Private, non-persisted P4 view over existing P5 bindings. Candidate IDs are
// lookup selectors, never the trusted caller, a route or permission to contact.
// No directory inventory, default selection, publication or provider call.
export function readSessionConversationCandidates({ root, projectId, sessionId = null, candidates, environment = process.env } = {}) {
  const result = { kind: "SessionConversationDiscoveryProjection", authorityPlane: "P4", sourcePlane: "P5",
    persisted: false, instructionAuthority: false, recoveryAuthority: false, routingAuthority: false,
    status: Array.isArray(candidates) ? "observed" : "invalid-candidates", readAt: new Date().toISOString(),
    interpretation: "At-check current operational-store mappings, not an atomic snapshot. Participation in this work, historical ownership, live activity, contact readiness and model input remain unknown.",
    rows: [], coverage: { requested: Array.isArray(candidates) ? candidates.length : null,
      maxCandidates: 16, inspected: 0, notInspectedByCandidateBound: 0, omittedByResponseBudget: 0,
      maxAdditionalBytes: SESSION_WORK_DEFAULT_CHARACTERS } };
  if (!Array.isArray(candidates)) return result;
  result.coverage.notInspectedByCandidateBound = Math.max(0, candidates.length - 16);
  for (const [index, candidate] of candidates.slice(0, 16).entries()) {
    result.coverage.inspected++;
    const base = { index, activity: "unknown", contactReadiness: "unknown", workParticipation: "unknown", ownerAssignment: "unknown", modelUse: "unknown" };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !["codex", "claude", "opencode"].includes(candidate.runtime)
      || !validId(candidate.native_session_id) || candidate.agent_id != null && !validId(candidate.agent_id)) {
      result.rows.push({ ...base, status: "invalid-selector", reasonCode: "INVALID_CONVERSATION_SELECTOR" }); continue;
    }
    const selector = { runtime: candidate.runtime, nativeSessionId: candidate.native_session_id,
      agentId: candidate.agent_id ?? null, environmentScope: candidate.environment_scope === "current" ? "current-operational-namespace" : "unsupported-other" };
    if (candidate.environment_scope !== "current" || candidate.host_id != null || candidate.hostId != null) {
      result.rows.push({ ...base, selector, status: "unsupported-environment", reasonCode: "CONVERSATION_ENVIRONMENT_NOT_ATTESTED",
        lookupPerformed: false, hostIdentityVerified: false }); continue;
    }
    try {
      const adapter = createSessionHostAdapter({ runtime: selector.runtime, nativeSessionId: selector.nativeSessionId,
        agentId: selector.agentId, environment });
      const first = adapter.read({ root }), last = adapter.read({ root });
      if (!same(first, last)) {
        result.rows.push({ ...base, selector, status: "changed-during-read", reasonCode: "CONVERSATION_BINDING_CHANGED",
          lookupPerformed: true, hostIdentityVerified: false }); continue;
      }
      if (last.projectId !== undefined && last.projectId !== projectId) throw Object.assign(new Error(), { code: "SESSION_HOST_BINDING_INTEGRITY" });
      const mapped = ["bound", "default"].includes(last.status);
      result.rows.push({ ...base, selector, status: mapped ? "stored-mapping" : last.status,
        lookupPerformed: true, hostIdentityVerified: false,
        binding: { status: last.status, revision: last.revision, digest: last.bindingDigest ?? null,
          sessionId: mapped ? last.sessionId : null },
        matchesRequestedSession: sessionId === null || !mapped ? null : last.sessionId === sessionId });
    } catch (error) {
      result.rows.push({ ...base, selector, status: "unavailable", reasonCode: reason(error), lookupPerformed: true, hostIdentityVerified: false });
    }
  }
  // This is a display bound, not a gate or a claim that an omitted candidate
  // has no mapping. All inspected rows keep their input order and identity.
  while (additionalResponseBytes(result) > result.coverage.maxAdditionalBytes && result.rows.length) {
    result.rows.pop(); result.coverage.omittedByResponseBudget++;
  }
  return result;
}
