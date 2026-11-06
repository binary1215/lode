import crypto from "node:crypto";
export const CLAUDE_SDK_DIGEST_PROFILE = "claude-sdk-message-digest-v1";
// JSON object key order is not message meaning. Values, arrays, roles, tools
// and exact strings remain covered; no SDK body leaves the child in this mode.
export function claudeMessageDigest(message) {
  const text = JSON.stringify(message, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return crypto.createHash("sha256").update(text).digest("hex");
}
