// OpenCode's plugin client used by this package is the v1 SDK shape
// (`client.session.get` / `client.session.prompt`) when session.get exists.
// `session.prompt` admits a user message into a live session. A missing method
// is not treated as success. When session.get is absent and hook, wait, or
// command exists, this calls prompt({ sessionID, text, delivery: "queue" }).
// That delivery value is the v2 plugin argument and has not been verified
// against a shipped OpenCode binary.

function messageIdOf(result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const candidates = [data?.info?.id, data?.message?.id, data?.id, data?.messageID];
  return candidates.find((value) => typeof value === "string" && value.length > 0 && value.length <= 512) || null;
}

export function opencodePromptAvailable(client) {
  return typeof client?.session?.prompt === "function";
}

export async function deliverOpenCodePrompt({ client, directory, sessionId, text, timeoutMs = 30000 } = {}) {
  if (typeof directory !== "string" || typeof sessionId !== "string" || typeof text !== "string")
    return { outcome: "unavailable", evidence: "opencode-prompt-input-invalid" };
  const session = client?.session;
  if (typeof session?.prompt !== "function") return { outcome: "unavailable", evidence: "opencode-prompt-api-missing" };
  // v1 SDK clients expose session.get({ path }). v2's plugin ctx.session.prompt
  // takes { sessionID, text, delivery } and has no path-style get.
  const v2 =
    typeof session.get !== "function" && (typeof session.hook === "function" || typeof session.wait === "function" || typeof session.command === "function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) return { outcome: "unavailable", evidence: "opencode-prompt-limit-invalid" };
  let timer;
  try {
    const pending = v2
      ? session.prompt({ sessionID: sessionId, text, delivery: "queue" })
      : session.prompt({ path: { id: sessionId }, query: { directory }, body: { parts: [{ type: "text", text }] } });
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("OpenCode prompt outcome unknown.")), timeoutMs);
      }),
    ]);
    if (result?.error) return { outcome: "unknown", evidence: "opencode-prompt-error-after-call" };
    const receipt = messageIdOf(result);
    if (!receipt) return { outcome: "unknown", evidence: v2 ? "opencode-v2-prompt-unconfirmed" : "opencode-prompt-unconfirmed" };
    return { outcome: "delivered", evidence: v2 ? "opencode-v2-session-prompt" : "opencode-session-prompt", receipt };
  } catch (error) {
    return { outcome: "unknown", evidence: "opencode-prompt-outcome-unknown" };
  } finally {
    clearTimeout(timer);
  }
}

export function opencodeChannel({ promptAvailable = false } = {}) {
  return promptAvailable ? { kind: "opencode-async" } : { kind: "opencode-next-prompt" };
}

export function opencodeLive(record, { recent }) {
  if (record?.channel?.kind !== "opencode-async" || !recent) return null;
  return { reachable: true, delivery: "async", evidence: "opencode-plugin-watch" };
}

export function opencodeDeliver() {
  return { outcome: "unavailable", evidence: "opencode-plugin-watch" };
}
