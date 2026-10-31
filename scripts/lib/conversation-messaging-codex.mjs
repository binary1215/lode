import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Codex documents `codex app-server --listen unix://` and `codex app-server proxy --sock`.
// The control socket speaks WebSocket, so this adapter never opens it with Node.
// Node cannot open AF_UNIX on Windows; the proxy is the documented stdio bridge
// there and on every other platform.

export function codexControlSocket(environment = process.env) {
  const home = environment?.CODEX_HOME;
  if (typeof home !== "string" || !path.isAbsolute(home)) return null;
  return path.join(home, "app-server-control", "app-server-control.sock");
}

export function codexProxyCommand(platform = process.platform) {
  return platform === "win32" ? "codex.cmd" : "codex";
}

export function codexTransportPlan({ platform = process.platform, socketPath } = {}) {
  if (typeof socketPath !== "string" || !socketPath || socketPath.includes("\0")) return { mode: "none" };
  return { mode: "proxy", command: codexProxyCommand(platform), args: ["app-server", "proxy", "--sock", socketPath] };
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

export function collectAncestors({ platform = process.platform, environment = process.env, pid = process.pid, spawnSyncImpl = spawnSync } = {}) {
  if (typeof environment?.LODE_CONVERSATION_ANCESTORS === "string") return environment.LODE_CONVERSATION_ANCESTORS.split("\n");
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
  const socketPath = codexControlSocket(environment);
  if (socketPath && ancestorUsesSharedEngine(ancestors) && socketExists(socketPath)) return { kind: "codex-engine", engineSocket: socketPath };
  return { kind: "codex-prompt" };
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
export async function deliverCodexTurn({ socketPath, platform = process.platform, threadId, text, spawnImpl = spawn, timeoutMs = 3000 } = {}) {
  const plan = codexTransportPlan({ platform, socketPath });
  if (plan.mode !== "proxy" || typeof threadId !== "string" || typeof text !== "string") return { outcome: "unavailable", evidence: "codex-engine-unavailable" };
  let child;
  try {
    child = spawnImpl(plan.command, plan.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const initialize = readResponse(child, 1, timeoutMs);
    await writeLine(child, rpc(1, "initialize", { clientInfo: { name: "lode", version: "0.3.0-beta.74" } }));
    const initialized = await initialize;
    if (!initialized || initialized.error) return { outcome: "unavailable", evidence: "codex-initialize-rejected" };
    await writeLine(child, JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const turn = readResponse(child, 2, timeoutMs);
    await writeLine(child, rpc(2, "turn/start", { threadId, input: [{ type: "text", text }] }));
    const started = await turn;
    const turnId = started?.result?.turn?.id;
    if (typeof turnId === "string" && turnId) return { outcome: "delivered", evidence: "codex-turn-start", receipt: turnId };
    return { outcome: "unavailable", evidence: "codex-turn-start-unconfirmed" };
  } catch {
    return { outcome: "unavailable", evidence: "codex-proxy-failed" };
  } finally {
    try { child?.stdin?.end(); } catch { /* The proxy exits with its client. */ }
    try { child?.kill?.(); } catch { /* A finished proxy has nothing to kill. */ }
  }
}
