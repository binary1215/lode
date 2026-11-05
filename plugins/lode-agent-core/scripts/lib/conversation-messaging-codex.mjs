import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { absoluteSystemExecutable } from "./native-session-process.mjs";
import { openConversationCodexProxy } from "./conversation-codex-proxy.mjs";

const packageVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

// Codex documents `codex app-server --listen unix://` and `codex app-server proxy --sock`.
// The control socket speaks WebSocket, so this adapter never opens it with Node.
// Node cannot open AF_UNIX on Windows; the proxy is the documented stdio bridge
// there and on every other platform.

export function codexHomeDirectory(environment = process.env) {
  if (typeof environment?.CODEX_HOME === "string" && path.isAbsolute(environment.CODEX_HOME)) return environment.CODEX_HOME;
  const home = environment?.HOME || environment?.USERPROFILE;
  return typeof home === "string" && path.isAbsolute(home) ? path.join(home, ".codex") : null;
}

export function codexControlSocket(environment = process.env) {
  const home = codexHomeDirectory(environment);
  return home ? path.join(home, "app-server-control", "app-server-control.sock") : null;
}

export function socketFromAncestorListen(commandLines) {
  if (!Array.isArray(commandLines)) return null;
  for (const line of commandLines) {
    if (typeof line !== "string") continue;
    const match = /--listen(?:=|\s+)(unix:\/\/\S*)/u.exec(line);
    if (!match) continue;
    const value = match[1];
    if (value === "unix://" || value === "unix:") return null;
    if (value.startsWith("unix://")) return value.slice("unix://".length) || null;
  }
  return null;
}

export function codexProxyCommand(platform = process.platform) {
  return platform === "win32" ? "codex.cmd" : "codex";
}

// Quotes, newlines, and NUL cannot be a single CreateProcess argument.
// Unicode, spaces, parentheses, apostrophes, 8.3 names, and \\?\ prefixes can.
function windowsSocketRejected(socketPath) {
  return typeof socketPath !== "string"
    || socketPath.length === 0
    || socketPath.length > 32767
    || /[\0\r\n"]/u.test(socketPath);
}

function windowsPathEntries(env) {
  return String(env?.PATH || env?.Path || "").split(";").map(entry => {
    const trimmed = entry.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    return trimmed;
  }).filter(entry => path.win32.isAbsolute(entry));
}

function windowsPathExtensions(env) {
  const raw = env?.PATHEXT || env?.Pathext || ".COM;.EXE;.BAT;.CMD";
  const extensions = String(raw).split(";").map(item => item.trim()).filter(item => /^\.(?:exe|com|cmd|bat)$/iu.test(item));
  return extensions.length ? extensions : [".COM", ".EXE", ".BAT", ".CMD"];
}

// Walk PATH in order and PATHEXT inside each directory, the way cmd.exe does.
// Only absolute paths are returned. A bare node.exe or codex.exe is never used:
// Windows searches the current directory before PATH for those names.
export function resolveCodexWindowsTarget({ env = process.env, exists = fs.existsSync, readFile = fs.readFileSync, execPath = process.execPath } = {}) {
  for (const dir of windowsPathEntries(env)) {
    for (const extension of windowsPathExtensions(env)) {
      const names = [`codex${extension}`, `codex${extension.toLowerCase()}`];
      const candidate = names.map(name => path.win32.join(dir, name)).find(file => path.win32.isAbsolute(file) && exists(file));
      if (!candidate) continue;
      if (extension.toLowerCase() === ".cmd" || extension.toLowerCase() === ".bat") {
        const parsed = readCodexCmdShim(candidate, exists, readFile, execPath);
        if (parsed && path.win32.isAbsolute(parsed.command)) return parsed;
        continue;
      }
      return { command: candidate, args: [] };
    }
  }
  return null;
}

function readCodexCmdShim(cmdFile, exists, readFile, execPath) {
  let text = "";
  try {
    const raw = readFile(cmdFile);
    text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  } catch { return null; }
  if (text.length > 65536 || text.includes("\0")) return null;
  const match = text.match(/%~?dp0%?\\([^"\r\n]+\.js)/iu);
  if (!match || match[1].includes("\0")) return null;
  const script = path.win32.normalize(path.win32.join(path.win32.dirname(cmdFile), match[1]));
  if (!path.win32.isAbsolute(script) || !script.toLowerCase().endsWith(".js") || !exists(script)) return null;
  const beside = path.win32.join(path.win32.dirname(cmdFile), "node.exe");
  const node = exists(beside) && path.win32.isAbsolute(beside) ? beside : (path.win32.isAbsolute(execPath) ? execPath : null);
  if (!node) return null;
  return { command: node, args: [script] };
}

// The socket path is one argv element. shell stays false so cmd.exe does not
// expand %VAR% or reinterpret Unicode as the OEM code page.
export function codexProxyLaunch({ platform = process.platform, socketPath, env = process.env, exists = fs.existsSync, readFile = fs.readFileSync, execPath = process.execPath } = {}) {
  if (windowsSocketRejected(socketPath)) return { mode: "none", evidence: "codex-proxy-socket-rejected" };
  const proxyArgs = ["app-server", "proxy", "--sock", socketPath];
  if (platform === "win32") {
    const target = resolveCodexWindowsTarget({ env, exists, readFile, execPath });
    if (!target || !path.win32.isAbsolute(target.command)) return { mode: "none", evidence: "codex-proxy-unresolved" };
    return { mode: "proxy", command: target.command, args: [...target.args, ...proxyArgs], shell: false };
  }
  return { mode: "proxy", command: codexProxyCommand(platform), args: proxyArgs, shell: false };
}

export function codexTransportPlan({ platform = process.platform, socketPath, env = process.env, exists = fs.existsSync, readFile = fs.readFileSync, execPath = process.execPath } = {}) {
  const launch = codexProxyLaunch({ platform, socketPath, env, exists, readFile, execPath });
  if (launch.mode !== "proxy") return { mode: "none", evidence: launch.evidence || "codex-engine-unavailable" };
  return { mode: "proxy", command: launch.command, args: launch.args, shell: false };
}

export function ancestorUsesSharedEngine(commandLines) {
  return Array.isArray(commandLines) && commandLines.some(line => typeof line === "string"
    && /\bapp-server\b/u.test(line) && /--listen\b/u.test(line) && /unix:\/\//u.test(line));
}

export function windowsProcessQuery(pid) {
  return {
    file: absoluteSystemExecutable("powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`],
  };
}

export function ancestorsFromProcessTable(rows, pid) {
  if (!Array.isArray(rows)) return [];
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row?.ProcessId);
    if (Number.isInteger(id)) byId.set(id, row);
  }
  const lines = [];
  let current = Number(pid);
  const seen = new Set();
  while (byId.has(current) && !seen.has(current) && lines.length < 32) {
    seen.add(current);
    const row = byId.get(current);
    if (typeof row.CommandLine === "string" && row.CommandLine) lines.push(row.CommandLine);
    const parent = Number(row.ParentProcessId);
    if (!Number.isInteger(parent) || parent === current) break;
    current = parent;
  }
  return lines;
}

export function linuxAncestors(pid = process.pid, readFile = fs.readFileSync) {
  const lines = [];
  let current = Number(pid);
  const seen = new Set();
  while (current > 0 && !seen.has(current) && lines.length < 32) {
    seen.add(current);
    let command = "", status = "";
    try {
      command = readFile(`/proc/${current}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
      status = readFile(`/proc/${current}/status`, "utf8");
    } catch { break; }
    if (command) lines.push(command);
    const parent = /^PPid:\s+(\d+)/mu.exec(status);
    if (!parent) break;
    current = Number(parent[1]);
  }
  return lines;
}

export function darwinProcessListCommand() {
  return { file: "ps", args: ["-ax", "-o", "pid=,ppid=,command="] };
}

export function ancestorsFromPsTable(text, pid) {
  const rows = new Map();
  for (const line of String(text || "").split(/\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { parent: Number(match[2]), command: match[3].trim() });
  }
  const lines = [];
  let current = Number(pid);
  const seen = new Set();
  while (rows.has(current) && !seen.has(current) && lines.length < 32) {
    seen.add(current);
    const row = rows.get(current);
    if (row.command) lines.push(row.command);
    if (!Number.isInteger(row.parent) || row.parent === current) break;
    current = row.parent;
  }
  return lines;
}

function ancestorWalk(pid, readOne) {
  const lines = [];
  let current = Number(pid);
  const seen = new Set();
  while (current > 1 && !seen.has(current) && lines.length < 8) {
    seen.add(current);
    const row = readOne(current);
    if (!row) break;
    if (row.command) lines.push(row.command);
    if (!Number.isInteger(row.parent) || row.parent === current) break;
    current = row.parent;
  }
  return lines;
}

export function collectAncestors({ platform = process.platform, environment = process.env, pid = process.pid, spawnSyncImpl = spawnSync } = {}) {
  if (typeof environment?.LODE_CONVERSATION_ANCESTORS === "string") return environment.LODE_CONVERSATION_ANCESTORS.split("\n");
  if (platform === "darwin") {
    return ancestorWalk(pid, current => {
      let result;
      try { result = spawnSyncImpl("ps", ["-o", "ppid=,command=", "-p", String(current)], { encoding: "utf8", timeout: 2000, shell: false, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }); }
      catch { return null; }
      const match = /^\s*(\d+)\s+(.*)$/u.exec(String(result?.stdout || ""));
      if (!match || result.status !== 0) return null;
      return { parent: Number(match[1]), command: match[2].trim() };
    });
  }
  if (platform === "win32") {
    return ancestorWalk(pid, current => {
      const command = windowsProcessQuery(current);
      let result;
      try { result = spawnSyncImpl(command.file, command.args, { encoding: "utf8", timeout: 2000, windowsHide: true, shell: false }); }
      catch { return null; }
      try {
        const parsed = JSON.parse(result?.stdout || "null");
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const row = rows.find(item => Number(item?.ProcessId) === current) || null;
        if (!row) return null;
        return { parent: Number(row.ParentProcessId), command: typeof row.CommandLine === "string" ? row.CommandLine : "" };
      } catch { return null; }
    });
  }
  if (platform === "linux") return linuxAncestors(pid);
  return [];
}

export function codexChannel({ environment = process.env, ancestors = [], socketExists = fs.existsSync } = {}) {
  if (!ancestorUsesSharedEngine(ancestors)) return { kind: "codex-next-prompt" };
  const socketPath = socketFromAncestorListen(ancestors) || codexControlSocket(environment);
  if (socketPath && socketExists(socketPath)) return { kind: "codex-immediate", socketPath };
  return { kind: "codex-next-prompt", evidence: socketPath ? "codex-engine-socket-missing" : "codex-home-unavailable" };
}

export function codexLive(record, { recent }) {
  const channel = record?.channel;
  if (channel?.kind !== "codex-immediate" || typeof channel.socketPath !== "string" || !fs.existsSync(channel.socketPath) || !recent) return null;
  return { reachable: true, delivery: "immediate", evidence: "codex-shared-engine" };
}

export function codexDeliver({ message, presence, platform, environment, signal, assertTarget }) {
  return deliverCodexTurn({ socketPath: presence.channel.socketPath, platform, threadId: presence.nativeSessionId, text: message.text, root: message.projectRoot, env: environment, signal, assertTarget });
}

function rpc(id, method, params) {
  return JSON.stringify(params === undefined ? { method, id } : { method, id, params }) + "\n";
}

function readResponse(child, id, timeoutMs, signal) {
  return new Promise(resolve => {
    let buffer = "", settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout?.off("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const abort = () => finish(null);
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) { finish(null); return; }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) finish(parsed);
        } catch { /* Notifications and partial lines are ignored until a matching id. */ }
      }
    };
    child.stdout?.on("data", onData);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

function writeLine(child, line) {
  return new Promise((resolve, reject) => {
    child.stdin.write(line, error => error ? reject(error) : resolve());
  });
}

// Only a known pre-turn failure can queue. Once turn/start may have been written,
// a missing response is unknown and must not cause automatic prompt redelivery.
export async function deliverCodexTurn({ socketPath, platform = process.platform, threadId, text, root, pluginRoot = path.resolve(import.meta.dirname, "../.."), supervisorSelection = null, spawnImpl = spawn, timeoutMs = 3000, env = process.env, exists = fs.existsSync, readFile = fs.readFileSync, execPath = process.execPath, signal, assertTarget } = {}) {
  if (signal?.aborted) return { outcome: "unavailable", evidence: "codex-proxy-cancelled-before-start" };
  const plan = codexProxyLaunch({ platform, socketPath, env, exists, readFile, execPath });
  if (plan.mode !== "proxy" || typeof threadId !== "string" || typeof text !== "string") {
    return { outcome: "unavailable", evidence: plan.evidence || "codex-engine-unavailable" };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return { outcome: "unavailable", evidence: "codex-proxy-limit-invalid" };
  let child, transport, turnAttempted = false, outcome, refusal;
  const protocol = async () => {
    if (spawnImpl !== spawn) {
      // Private protocol fault fixtures only. CLI/MCP never accept or forward
      // a spawn callback, endpoint override or supervisor selection argument.
      if (!process.env.NODE_TEST_CONTEXT && !process.execArgv.includes("--test")) return { outcome: "unavailable", evidence: "codex-proxy-fixture-outside-test" };
      child = spawnImpl(plan.command, plan.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } else {
      if (typeof root !== "string" || !path.isAbsolute(root)) return { outcome: "unavailable", evidence: "codex-proxy-project-unavailable" };
      const executablePath = path.isAbsolute(plan.command) ? plan.command : String(env.PATH || env.Path || "").split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, plan.command)).find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
      if (!executablePath) return { outcome: "unavailable", evidence: "codex-proxy-unresolved" };
      transport = openConversationCodexProxy({ executablePath, args: plan.args, root, environment: env, pluginRoot, supervisorSelection, timeoutMs: 4 * timeoutMs + 6000, signal, assertTarget });
      child = transport.child;
    }
    const initialize = readResponse(child, 1, timeoutMs, signal);
    await writeLine(child, rpc(1, "initialize", { clientInfo: { name: "lode", version: packageVersion } }));
    const initialized = await initialize;
    if (!initialized || initialized.error) return { outcome: "unavailable", evidence: "codex-initialize-rejected" };
    await writeLine(child, JSON.stringify({ method: "initialized", params: {} }) + "\n");
    if (signal?.aborted) return { outcome: "unavailable", evidence: "codex-proxy-cancelled-before-turn" };
    const resume = readResponse(child, 2, timeoutMs, signal);
    await writeLine(child, rpc(2, "thread/resume", { threadId }));
    const resumed = await resume;
    if (!resumed || resumed.error) return { outcome: "unavailable", evidence: "codex-thread-resume-rejected" };
    if (signal?.aborted) return { outcome: "unavailable", evidence: "codex-proxy-cancelled-before-turn" };
    const turn = readResponse(child, 3, timeoutMs, signal);
    turnAttempted = true;
    await writeLine(child, rpc(3, "turn/start", { threadId, input: [{ type: "text", text }] }));
    const started = await turn;
    const turnId = started?.result?.turn?.id;
    if (typeof turnId === "string" && turnId) return { outcome: "delivered", evidence: "codex-turn-start", receipt: turnId };
    return { outcome: "unknown", evidence: "codex-turn-start-unconfirmed" };
  };
  try {
    outcome = await protocol();
  } catch (error) {
    if (error.conversationTargetRefused) refusal = error;
    outcome = { outcome: turnAttempted ? "unknown" : "unavailable", evidence: error?.code === "EINVAL" ? "codex-proxy-spawn-rejected" : "codex-proxy-failed", reasonCode: error.code ?? null };
  } finally {
    if (transport) {
      let cleanup;
      try { cleanup = await transport.close(); } catch (error) { cleanup = { verified: false, code: error.code || "CONVERSATION_PROXY_CLEANUP_UNVERIFIED" }; }
      if (!cleanup.verified) outcome = { outcome: turnAttempted ? "unknown" : "unavailable", evidence: "codex-proxy-cleanup-unverified", deliveryEvidence: outcome, cleanup };
      else outcome = { ...outcome, cleanup };
      if (refusal && !cleanup.verified) refusal.proxyCleanup = cleanup;
    } else {
      try { child?.stdin?.end(); child?.kill?.(); } catch { /* Synthetic protocol fixture only. */ }
    }
  }
  if (refusal) throw refusal;
  return outcome;
}
