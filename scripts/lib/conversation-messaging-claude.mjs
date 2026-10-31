import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Claude Code documents the inbox socket (Unix) or named pipe (native Windows),
// the CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN variables, and
// the auth line {"type":"auth","token":"..."}. Native Windows closes the pipe
// unless that line is first. The peer-key file layout and the user-message line
// are not specified by those docs; both stay in this adapter.

const TOKEN = /^[A-Za-z0-9._~+/-]{8,256}$/;

export function normalizeClaudeSocketPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length < 1 || socketPath.length > 1024) return null;
  if (socketPath.includes("\0") || socketPath.split(/[\\/]/u).includes("..")) return null;
  if (/^\\\\[.?]\\pipe\\/u.test(socketPath)) return socketPath;
  if (!path.isAbsolute(socketPath)) return null;
  const resolved = path.resolve(socketPath);
  if (resolved.split(/[\\/]/u).includes("..")) return null;
  return resolved;
}

export function claudeSocketDigest(socketPath) {
  const normalized = normalizeClaudeSocketPath(socketPath);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
}

export function claudeConfigDirectory(environment = process.env) {
  const configured = environment?.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && path.isAbsolute(configured)) return configured;
  const home = environment?.HOME || environment?.USERPROFILE;
  return home ? path.join(home, ".claude") : null;
}

// Undocumented: Claude writes <config>/sessions/<pid>.<sha256(socket path)>.key
// containing {"peerToken":"..."}. We only read it, and only under the caller's
// CLAUDE_CONFIG_DIR. A missing token refuses the Windows pipe rather than guessing.
export function readClaudePeerToken({ environment = process.env, socketPath, readDir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const digest = claudeSocketDigest(socketPath);
  const directory = claudeConfigDirectory(environment);
  if (!digest || !directory) return null;
  const ownSocket = environment?.CLAUDE_CODE_MESSAGING_SOCKET;
  const ownToken = environment?.CLAUDE_CODE_MESSAGING_TOKEN;
  if (typeof ownToken === "string" && TOKEN.test(ownToken) && normalizeClaudeSocketPath(ownSocket) === normalizeClaudeSocketPath(socketPath)) return ownToken;
  let names = [];
  try { names = readDir(path.join(directory, "sessions")); }
  catch { return null; }
  const suffix = `.${digest}.key`;
  for (const name of names) {
    if (!/^[0-9]+\.[a-f0-9]{64}\.key$/u.test(name) || !name.endsWith(suffix)) continue;
    try {
      const parsed = JSON.parse(readFile(path.join(directory, "sessions", name), "utf8"));
      if (typeof parsed?.peerToken === "string" && TOKEN.test(parsed.peerToken)) return parsed.peerToken;
    } catch { /* An unreadable key is not a token. */ }
  }
  return null;
}

export function claudeWireLines({ platform, token, message }) {
  if (platform === "win32" && !TOKEN.test(token || "")) return { ok: false, reason: "CLAUDE_INBOX_AUTH_REQUIRED" };
  const lines = [];
  if (TOKEN.test(token || "")) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({
    msgV: 1, msg_id: message.id, type: "user", priority: "next",
    session_id: message.from.nativeSessionId,
    message: { role: "user", content: message.text },
  }));
  return { ok: true, lines };
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const fail = error => { socket.destroy(); reject(error); };
    socket.once("connect", () => { socket.removeListener("error", fail); resolve(socket); });
    socket.once("error", fail);
  });
}

function writeAll(socket, text) {
  return new Promise((resolve, reject) => {
    socket.write(text, error => error ? reject(error) : resolve());
  });
}

// A completed write is "sent": Claude may still hold or drop the line, and the
// socket does not confirm that the receiving model read it.
export async function deliverClaudeInbox({ socketPath, platform = process.platform, token, message, connectImpl = connectSocket } = {}) {
  const wire = claudeWireLines({ platform, token, message });
  if (!wire.ok) return { outcome: "unavailable", evidence: wire.reason };
  if (!normalizeClaudeSocketPath(socketPath)) return { outcome: "unavailable", evidence: "claude-inbox-path-invalid" };
  let socket;
  try {
    socket = await connectImpl(socketPath);
    await writeAll(socket, wire.lines.join("\n") + "\n");
    return { outcome: "sent", evidence: platform === "win32" ? "claude-inbox-pipe-auth" : "claude-inbox-socket" };
  } catch {
    return { outcome: "unavailable", evidence: "claude-inbox-unreachable" };
  } finally { try { socket?.destroy(); } catch { /* The write result is already decided. */ } }
}

export function claudeChannel({ environment = process.env, socketExists = fs.existsSync } = {}) {
  const socketPath = normalizeClaudeSocketPath(environment?.CLAUDE_CODE_MESSAGING_SOCKET);
  if (!socketPath) return { kind: "claude-prompt" };
  if (/^\\\\[.?]\\pipe\\/u.test(socketPath)) return { kind: "claude-inbox", socketPath };
  if (!socketExists(socketPath)) return { kind: "claude-prompt" };
  return { kind: "claude-inbox", socketPath };
}
