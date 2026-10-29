import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// GC eligibility only. No provider, Session, executable from the Project, or
// ordinary-work probe. Unknown/remote filesystems preserve, never infer local.
const LINUX_LOCAL = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]); // ext*, XFS, Btrfs, tmpfs
export function classifySnapshotFileSystem({ platform, type, driveType }) {
  if (platform === "win32") return driveType === 3 ? "qualified-local" : "unsupported-or-unknown";
  if (platform === "linux") return LINUX_LOCAL.has(Number(type)) ? "qualified-local" : "unsupported-or-unknown";
  return "unsupported-or-unknown";
}
async function windowsDriveType(root, { signal, onProcess } = {}) {
  const drive = /^[a-z]:[\\/]/i.exec(root)?.[0];
  if (!drive) return null;
  const command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Only a validated drive letter is interpolated, never Project source/text.
  const script = `[ordered]@{driveType=[int]([System.IO.DriveInfo]::new('${drive[0]}:\\').DriveType);created=[System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const event = (kind, details = {}) => { try { onProcess?.({ event: kind, purpose: "snapshot-filesystem-qualification", parentPid: process.pid, command: [command, ...args], cwd: root, ports: [], ...details }); } catch { /* Diagnostic does not grant or prevent effects. */ } };
  event("planned", { pid: null });
  return new Promise(resolve => {
    let child, output = "", failed = false, escalation, timer;
    const stop = () => {
      failed = true;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 250);
    };
    try { child = spawn(command, args, { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve(null); return; }
    timer = setTimeout(stop, 3000);
    signal?.addEventListener?.("abort", stop, { once: true });
    child.once("spawn", () => { event("started", { pid: child.pid }); if (signal?.aborted) stop(); });
    child.stdout.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 2048) stop(); });
    child.stderr.on("data", () => { failed = true; });
    child.once("error", () => { failed = true; });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener?.("abort", stop);
      let document; try { document = JSON.parse(output); } catch { failed = true; }
      event("closed", { pid: child.pid ?? null, exitCode: code, signal: closeSignal, created: document?.created ?? null });
      resolve(!failed && code === 0 && Number.isInteger(document?.driveType) && document.driveType >= 0 && document.driveType <= 6 ? document.driveType : null);
    });
  });
}
export async function qualifySnapshotFileSystem({ root, signal, onProcess } = {}) {
  try {
    root = fs.realpathSync(root);
    if (/^(?:\\\\|\/\/)/.test(root)) return { status: "unsupported-or-unknown", reasonCode: "UNSUPPORTED_SHARED_STORAGE" };
    const platform = process.platform;
    const driveType = platform === "win32" ? await windowsDriveType(root, { signal, onProcess }) : undefined;
    const type = platform === "linux" ? fs.statfsSync(root).type : undefined;
    const status = classifySnapshotFileSystem({ platform, driveType, type });
    return { status, platform, ...(driveType !== undefined ? { driveType } : {}), ...(type !== undefined ? { type } : {}),
      ...(status !== "qualified-local" ? { reasonCode: "UNSUPPORTED_OR_UNKNOWN_GC_FILESYSTEM" } : {}),
      boundary: "OS filesystem classification; not proof of every hidden backing layer or noncooperating host" };
  } catch (error) { return { status: "unsupported-or-unknown", reasonCode: error.code || "GC_FILESYSTEM_UNAVAILABLE" }; }
}
