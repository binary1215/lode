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

export async function deliverOpenCodePrompt({ client, directory, sessionId, text } = {}) {
  if (!opencodePromptAvailable(client)) return { outcome: "unavailable", evidence: "opencode-prompt-api-missing" };
  if (typeof directory !== "string" || typeof sessionId !== "string" || typeof text !== "string") return { outcome: "unavailable", evidence: "opencode-prompt-input-invalid" };
  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      query: { directory },
      body: { parts: [{ type: "text", text }] },
    });
    if (result?.error) return { outcome: "unavailable", evidence: "opencode-prompt-rejected" };
    const receipt = messageIdOf(result);
    if (!receipt) return { outcome: "sent", evidence: "opencode-prompt-unconfirmed" };
    return { outcome: "delivered", evidence: "opencode-session-prompt", receipt };
  } catch {
    return { outcome: "unavailable", evidence: "opencode-prompt-failed" };
  }
}

export function opencodeChannel({ promptAvailable = false } = {}) {
  return promptAvailable ? { kind: "opencode-prompt" } : { kind: "opencode-inbox" };
}
