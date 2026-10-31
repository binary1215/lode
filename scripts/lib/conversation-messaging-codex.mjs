import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

// cmd.exe expands %VAR% even inside quotes, and it does not treat \" as an
// escaped quote. Reject those characters instead of trying to quote them.
// The allowlist is letters, digits, and the path punctuation a socket uses.
function windowsSocketSafe(socketPath) {
  return typeof socketPath === "string"
    && socketPath.length > 0
    && socketPath.length <= 260
    && !socketPath.endsWith("\\")
    && /^[A-Za-z0-9._:\\/ -]+$/.test(socketPath);
}

// /s strips one leading and one trailing quote. The doubled opening quote
// leaves the command name quoted after that strip. Each argument is quoted
// on its own. No backslash-escaped quotes.
function quoteCmdInvocation(parts) {
  const [command, ...rest] = parts;
  return `""${command}" ${rest.map(item => `"${item}"`).join(" ")}"`;
}

// Node refuses `spawn("codex.cmd", { shell: false })` with EINVAL. Windows goes
// through cmd.exe /d /s /c so the batch shim can run without shell:true.
export function codexProxyLaunch({ platform = process.platform, socketPath, comSpec = "cmd.exe" } = {}) {
  if (typeof socketPath !== "string" || !socketPath || socketPath.includes("\0")) return { mode: "none", evidence: "codex-proxy-socket-rejected" };
  const command = codexProxyCommand(platform);
  const args = ["app-server", "proxy", "--sock", socketPath];
  if (platform === "win32") {
    if (!windowsSocketSafe(socketPath)) return { mode: "none", evidence: "codex-proxy-socket-rejected" };
    return {
      mode: "proxy", command: comSpec, args: ["/d", "/s", "/c", quoteCmdInvocation([command, ...args])],
      shell: false, windowsVerbatimArguments: true,
    };
  }
  return { mode: "proxy", command, args, shell: false };
}

export function codexTransportPlan({ platform = process.platform, socketPath } = {}) {
  const launch = codexProxyLaunch({ platform, socketPath });
  if (launch.mode !== "proxy") return { mode: "none", evidence: launch.evidence || "codex-engine-unavailable" };
  return {
    mode: "proxy", command: launch.command, args: launch.args, shell: launch.shell,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}

// child.kill on Windows stops cmd.exe and can leave the proxy running.
// taskkill /T /F stops that process tree. POSIX still signals the direct child.
export function stopCodexProxy(child, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (!child) return;
  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      spawnSyncImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
    } catch { /* The proxy may already have exited. */ }
  }
  try { child.kill?.(); } catch { /* A finished proxy has nothing to kill. */ }
}

export function ancestorUsesSharedEngine(commandLines) {
  return Array.isArray(commandLines) && commandLines.some(line => typeof line === "string"
    && /\bapp-server\b/u.test(line) && /--listen\b/u.test(line) && /unix:\/\//u.test(line));
}

export function windowsProcessListCommand() {
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
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

export function collectAncestors({ platform = process.platform, environment = process.env, pid = process.pid, spawnSyncImpl = spawnSync } = {}) {
  if (typeof environment?.LODE_CONVERSATION_ANCESTORS === "string") return environment.LODE_CONVERSATION_ANCESTORS.split("\n");
  if (platform === "darwin") {
    const command = darwinProcessListCommand();
    let result;
    try { result = spawnSyncImpl(command.file, command.args, { encoding: "utf8", timeout: 2000, shell: false }); }
    catch { return []; }
    if (!result || result.status !== 0 || typeof result.stdout !== "string") return [];
    return ancestorsFromPsTable(result.stdout, pid);
  }
  if (platform === "win32") {
    const command = windowsProcessListCommand();
    let result;
    try { result = spawnSyncImpl(command.file, command.args, { encoding: "utf8", timeout: 2000, windowsHide: true, shell: false }); }
    catch { return []; }
    if (!result || result.status !== 0 || typeof result.stdout !== "string") return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return ancestorsFromProcessTable(Array.isArray(parsed) ? parsed : [parsed], pid);
    } catch { return []; }
  }
  if (platform === "linux") return linuxAncestors(pid);
  return [];
}

export function codexChannel({ environment = process.env, ancestors = [], socketExists = fs.existsSync } = {}) {
  if (!ancestorUsesSharedEngine(ancestors)) return { kind: "codex-prompt" };
  const socketPath = socketFromAncestorListen(ancestors) || codexControlSocket(environment);
  if (socketPath && socketExists(socketPath)) return { kind: "codex-engine", engineSocket: socketPath };
  return { kind: "codex-prompt", evidence: socketPath ? "codex-engine-socket-missing" : "codex-home-unavailable" };
}

function rpc(id, method, params) {
  return JSON.stringify(params === undefined ? { method, id } : { method, id, params }) + "\n";
}

function readResponse(child, id, timeoutMs) {
  return new Promise(resolve => {
    let buffer = "", settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) finish(parsed);
        } catch { /* Notifications and partial lines are ignored until a matching id. */ }
      }
    };
    child.stdout?.on("data", onData);
  });
}

function writeLine(child, line) {
  return new Promise((resolve, reject) => {
    child.stdin.write(line, error => error ? reject(error) : resolve());
  });
}

// turn/start is delivered only when the proxy returns a turn id. Anything else
// leaves the message queued. The call does not override sandbox or approval policy.
export async function deliverCodexTurn({ socketPath, platform = process.platform, threadId, text, spawnImpl = spawn, spawnSyncImpl = spawnSync, timeoutMs = 3000, comSpec = "cmd.exe" } = {}) {
  const plan = codexProxyLaunch({ platform, socketPath, comSpec });
  if (plan.mode !== "proxy" || typeof threadId !== "string" || typeof text !== "string") {
    return { outcome: "unavailable", evidence: plan.evidence || "codex-engine-unavailable" };
  }
  let child;
  try {
    const options = { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: plan.shell === true };
    if (plan.windowsVerbatimArguments) options.windowsVerbatimArguments = true;
    child = spawnImpl(plan.command, plan.args, options);
    const initialize = readResponse(child, 1, timeoutMs);
    await writeLine(child, rpc(1, "initialize", { clientInfo: { name: "lode", version: packageVersion } }));
    const initialized = await initialize;
    if (!initialized || initialized.error) return { outcome: "unavailable", evidence: "codex-initialize-rejected" };
    await writeLine(child, JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const resume = readResponse(child, 2, timeoutMs);
    await writeLine(child, rpc(2, "thread/resume", { threadId }));
    const resumed = await resume;
    if (!resumed || resumed.error) return { outcome: "unavailable", evidence: "codex-thread-resume-rejected" };
    const turn = readResponse(child, 3, timeoutMs);
    await writeLine(child, rpc(3, "turn/start", { threadId, input: [{ type: "text", text }] }));
    const started = await turn;
    const turnId = started?.result?.turn?.id;
    if (typeof turnId === "string" && turnId) return { outcome: "delivered", evidence: "codex-turn-start", receipt: turnId };
    return { outcome: "unavailable", evidence: "codex-turn-start-unconfirmed" };
  } catch (error) {
    return { outcome: "unavailable", evidence: error?.code === "EINVAL" ? "codex-proxy-spawn-rejected" : "codex-proxy-failed" };
  } finally {
    try { child?.stdin?.end(); } catch { /* The proxy exits with its client. */ }
    stopCodexProxy(child, { platform, spawnSyncImpl });
  }
}
