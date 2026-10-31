// OpenCode's plugin client used by this package is the v1 SDK shape
// (`client.session.get` / `client.session.prompt`). `session.prompt` is the
// documented way to admit a user message into a live session. A missing method
// is not treated as success. The v2 `ctx.session.prompt({ sessionID, text })`
// surface is a different plugin entry and is not called from here.

function messageIdOf(result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const candidates = [data?.info?.id, data?.message?.id, data?.id, data?.messageID];
  return candidates.find(value => typeof value === "string" && value.length > 0 && value.length <= 512) || null;
}

export function opencodePromptAvailable(client) {
  return typeof client?.session?.prompt === "function";
}

function busy(error) {
  const text = `${error?.name || ""} ${error?.code || ""} ${error?.message || ""}`;
  return /busy/iu.test(text);
}

export async function deliverOpenCodePrompt({ client, directory, sessionId, text } = {}) {
  if (typeof directory !== "string" || typeof sessionId !== "string" || typeof text !== "string") return { outcome: "unavailable", evidence: "opencode-prompt-input-invalid" };
  const session = client?.session;
  if (typeof session?.prompt !== "function") return { outcome: "unavailable", evidence: "opencode-prompt-api-missing" };
  // v1 SDK clients expose session.get({ path }). v2's plugin ctx.session.prompt
  // takes { sessionID, text, delivery } and has no path-style get.
  const v2 = typeof session.get !== "function" && (typeof session.hook === "function" || typeof session.wait === "function" || typeof session.command === "function");
  try {
    const result = v2
      ? await session.prompt({ sessionID: sessionId, text, delivery: "queue" })
      : await session.prompt({ path: { id: sessionId }, query: { directory }, body: { parts: [{ type: "text", text }] } });
    if (result?.error) return { outcome: "unavailable", evidence: busy(result.error) ? "opencode-session-busy" : "opencode-prompt-rejected" };
    const receipt = messageIdOf(result);
    if (!receipt) return { outcome: "sent", evidence: v2 ? "opencode-v2-prompt-unconfirmed" : "opencode-prompt-unconfirmed" };
    return { outcome: "delivered", evidence: v2 ? "opencode-v2-session-prompt" : "opencode-session-prompt", receipt };
  } catch (error) {
    return { outcome: "unavailable", evidence: busy(error) ? "opencode-session-busy" : "opencode-prompt-failed" };
  }
}

export function opencodeChannel({ promptAvailable = false } = {}) {
  return promptAvailable ? { kind: "opencode-prompt" } : { kind: "opencode-inbox" };
}
