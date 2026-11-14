import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { assertConversationTarget } from "./conversation-mailbox-storage.mjs";
import { sha256Hex } from "../core/digest.mjs";

// Claude Code documents the inbox socket (Unix) or named pipe (native Windows),
// the CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN variables, and
// the auth line {"type":"auth","token":"..."}. Native Windows closes the pipe
// unless that line is first. The peer-key file layout and the user-message line
// are not specified by those docs; both stay in this adapter.

const TOKEN = /^[A-Za-z0-9._~+/-]{8,256}$/;

export function normalizeClaudeSocketPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length < 1 || socketPath.length > 32767) return null;
  if (socketPath.includes("\0") || /[\r\n"]/u.test(socketPath)) return null;
  if (socketPath.split(/[\\/]/u).includes("..")) return null;
  // path.win32.resolve drops the \\?\ prefix. Keep extended and device paths,
  // including Korean pipe names, as the caller wrote them.
  if (/^\\\\[.?]\\/u.test(socketPath)) return socketPath;
  const win = /^[A-Za-z]:[\\/]/u.test(socketPath) || socketPath.startsWith("\\\\");
  const pathApi = win ? path.win32 : path;
  if (!pathApi.isAbsolute(socketPath)) return null;
  const resolved = pathApi.resolve(socketPath);
  if (resolved.split(/[\\/]/u).includes("..")) return null;
  return resolved;
}

export function claudeSocketDigest(socketPath) {
  const normalized = normalizeClaudeSocketPath(socketPath);
  if (!normalized) return null;
  return sha256Hex(Buffer.from(normalized, "utf8"));
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
function sessionKeyNames(environment, readDir) {
  const directory = claudeConfigDirectory(environment);
  if (!directory) return [];
  try {
    return readDir(path.join(directory, "sessions")).filter((name) => /^[0-9]+\.[a-f0-9]{64}\.key$/u.test(name));
  } catch {
    return [];
  }
}

// Listing only needs to know that a key file exists. The token bytes are read
// later, and only for the one socket we are about to write.
export function claudePeerTokenPresent({ environment = process.env, socketPath, readDir = fs.readdirSync } = {}) {
  const digest = claudeSocketDigest(socketPath);
  if (!digest) return false;
  const ownToken = environment?.CLAUDE_CODE_MESSAGING_TOKEN;
  if (
    typeof ownToken === "string" &&
    TOKEN.test(ownToken) &&
    normalizeClaudeSocketPath(environment?.CLAUDE_CODE_MESSAGING_SOCKET) === normalizeClaudeSocketPath(socketPath)
  )
    return true;
  const suffix = `.${digest}.key`;
  return sessionKeyNames(environment, readDir).some((name) => name.endsWith(suffix));
}

export function readClaudePeerToken({ environment = process.env, socketPath, readDir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const digest = claudeSocketDigest(socketPath);
  const directory = claudeConfigDirectory(environment);
  if (!digest || !directory) return null;
  const ownSocket = environment?.CLAUDE_CODE_MESSAGING_SOCKET;
  const ownToken = environment?.CLAUDE_CODE_MESSAGING_TOKEN;
  if (typeof ownToken === "string" && TOKEN.test(ownToken) && normalizeClaudeSocketPath(ownSocket) === normalizeClaudeSocketPath(socketPath)) return ownToken;
  const suffix = `.${digest}.key`;
  const match = sessionKeyNames(environment, readDir).find((name) => name.endsWith(suffix));
  if (!match) return null;
  try {
    const parsed = JSON.parse(readFile(path.join(directory, "sessions", match), "utf8"));
    if (typeof parsed?.peerToken === "string" && TOKEN.test(parsed.peerToken)) return parsed.peerToken;
  } catch {
    /* An unreadable key is not a token. */
  }
  return null;
}

export function claudeWireLines({ platform, token, message }) {
  if (platform === "win32" && !TOKEN.test(token || "")) return { ok: false, reason: "CLAUDE_INBOX_AUTH_REQUIRED" };
  const lines = [];
  if (TOKEN.test(token || "")) lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(
    JSON.stringify({
      msgV: 1,
      msg_id: message.id,
      type: "user",
      priority: "next",
      session_id: message.from.nativeSessionId,
      message: { role: "user", content: message.text },
    }),
  );
  return { ok: true, lines };
}

function connectSocket(socketPath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.on("error", () => {});
    const abort = () => {
      socket.destroy();
      reject(Object.assign(Error("Claude connection cancelled."), { code: "CONVERSATION_TRANSPORT_TIMEOUT" }));
    };
    const fail = (error) => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      signal?.removeEventListener("abort", abort);
      socket.removeListener("error", fail);
      resolve(socket);
    });
    socket.once("error", fail);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function writeAll(socket, text) {
  return new Promise((resolve, reject) => {
    const error = (value) => {
      socket.off?.("error", error);
      reject(value);
    };
    socket.once?.("error", error);
    try {
      socket.write(text, (failure) => {
        socket.off?.("error", error);
        if (failure) reject(failure);
        else resolve();
      });
    } catch (failure) {
      error(failure);
    }
  });
}

// A completed write is "sent": Claude may still hold or drop the line, and the
// socket does not confirm that the receiving model read it.
export async function deliverClaudeInbox({
  socketPath,
  platform = process.platform,
  token,
  message,
  connectImpl = connectSocket,
  timeoutMs = 3000,
  signal,
  assertTarget,
} = {}) {
  if (signal?.aborted) return { outcome: "unavailable", evidence: "claude-inbox-cancelled-before-write" };
  const wire = claudeWireLines({ platform, token, message, signal, assertTarget });
  if (!wire.ok) return { outcome: "unavailable", evidence: wire.reason };
  if (!normalizeClaudeSocketPath(socketPath)) return { outcome: "unavailable", evidence: "claude-inbox-path-invalid" };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return { outcome: "unavailable", evidence: "claude-inbox-limit-invalid" };
  let socket,
    attempted = false,
    finished = false,
    timer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      (async () => {
        assertConversationTarget(assertTarget);
        const connected = await connectImpl(socketPath, { signal: controller.signal });
        if (finished) {
          connected?.destroy();
          throw Error("Late connection closed.");
        }
        socket = connected;
        assertConversationTarget(assertTarget);
        if (signal?.aborted) throw Error("Cancelled before socket write.");
        attempted = true;
        await writeAll(socket, wire.lines.join("\n") + "\n");
        return { outcome: "sent", evidence: platform === "win32" ? "claude-inbox-pipe-auth" : "claude-inbox-socket" };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error("Claude transport deadline."), { code: "CONVERSATION_TRANSPORT_TIMEOUT" })), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error.conversationTargetRefused) throw error;
    return { outcome: attempted ? "unknown" : "unavailable", evidence: attempted ? "claude-inbox-write-unconfirmed" : "claude-inbox-unreachable" };
  } finally {
    finished = true;
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    controller.abort();
    try {
      socket?.destroy();
    } catch {
      /* The write result is already decided. */
    }
  }
}

export function claudeChannel({ environment = process.env, socketExists = fs.existsSync } = {}) {
  const socketPath = normalizeClaudeSocketPath(environment?.CLAUDE_CODE_MESSAGING_SOCKET);
  if (!socketPath) return { kind: "claude-next-prompt" };
  if (/^\\\\[.?]\\pipe\\/u.test(socketPath)) return { kind: "claude-immediate", socketPath };
  if (!socketExists(socketPath)) return { kind: "claude-next-prompt" };
  return { kind: "claude-immediate", socketPath };
}

export function claudeLive(record, { environment, platform, fresh, recent }) {
  const channel = record?.channel;
  if (channel?.kind !== "claude-immediate" || typeof channel.socketPath !== "string") return null;
  const pipe = /^\\\\[.?]\\pipe\\/u.test(channel.socketPath);
  const present = pipe || fs.existsSync(channel.socketPath);
  if (!(present && recent)) return null;
  if (platform === "win32" && !claudePeerTokenPresent({ environment, socketPath: channel.socketPath }))
    return { reachable: fresh, delivery: fresh ? "next-prompt" : "unreachable", evidence: "claude-windows-auth-missing" };
  return { reachable: true, delivery: "immediate", evidence: pipe ? "claude-inbox-pipe" : "claude-inbox-socket" };
}

export async function claudeDeliver({ message, presence, environment, platform, signal, assertTarget }) {
  const token = readClaudePeerToken({ environment, socketPath: presence.channel.socketPath });
  return deliverClaudeInbox({ socketPath: presence.channel.socketPath, platform, token, message, signal, assertTarget });
}
