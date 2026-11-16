import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// GC eligibility only. No provider, Session, executable from the Project, or
// ordinary-work probe. Unknown/remote filesystems preserve, never infer local.
const LINUX_LOCAL = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]); // ext*, XFS, Btrfs, tmpfs
const DARWIN_LOCAL = new Set(["apfs", "hfs", "msdos"]);
const darwinNameCache = new Map();
export function classifySnapshotFileSystem({ platform, type, driveType, fstypeName }) {
  if (platform === "win32") return driveType === 3 ? "qualified-local" : "unsupported-or-unknown";
  if (platform === "linux") return LINUX_LOCAL.has(Number(type)) ? "qualified-local" : "unsupported-or-unknown";
  if (platform === "darwin") return DARWIN_LOCAL.has(String(fstypeName || "").toLowerCase()) ? "qualified-local" : "unsupported-or-unknown";
  return "unsupported-or-unknown";
}
// macOS stat(1) reports file type, not the filesystem. /sbin/mount lines look like
// "/dev/disk1s1 on / (apfs, local, journaled)". The first option is the type.
// Cached per root for this process. Shell is never used.
export function filesystemNameFromMountTable(text, root) {
  const target = String(root || "/").replace(/\/+$/, "") + "/";
  let best = "";
  let name = "";
  for (const line of String(text || "").split("\n")) {
    const on = line.indexOf(" on ");
    const paren = line.lastIndexOf(" (");
    if (on < 0 || paren <= on || !line.endsWith(")")) continue;
    const point = line.slice(on + 4, paren).replace(/\/+$/, "") + "/";
    if ((target === point || target.startsWith(point)) && point.length >= best.length) {
      best = point;
      name = line
        .slice(paren + 2, -1)
        .split(",")[0]
        .trim()
        .toLowerCase();
    }
  }
  return name;
}
export function darwinFilesystemName(root) {
  const key = path.resolve(String(root));
  if (darwinNameCache.has(key)) return darwinNameCache.get(key);
  let name = "";
  try {
    const result = spawnSync("/sbin/mount", [], { encoding: "utf8", timeout: 2000, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
    if (result.status === 0) name = filesystemNameFromMountTable(result.stdout, key);
  } catch {
    name = "";
  }
  darwinNameCache.set(key, name);
  return name;
}
async function windowsDriveType(root, { signal, onProcess, deadline = Date.now() + 3000 } = {}) {
  const drive = /^[a-z]:[\\/]/i.exec(root)?.[0];
  if (!drive) return null;
  const command = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Only a validated drive letter is interpolated, never Project source/text.
  const script = `[ordered]@{driveType=[int]([System.IO.DriveInfo]::new('${drive[0]}:\\').DriveType);created=[System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const event = (kind, details = {}) => {
    try {
      onProcess?.({
        event: kind,
        purpose: "snapshot-filesystem-qualification",
        parentPid: process.pid,
        command: [command, ...args],
        cwd: root,
        ports: [],
        ...details,
      });
    } catch {
      /* Diagnostic does not grant or prevent effects. */
    }
  };
  event("planned", { pid: null });
  return new Promise((resolve) => {
    let child,
      output = "",
      failed = false,
      escalation,
      timer;
    const stop = () => {
      failed = true;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
    };
    try {
      child = spawn(command, args, { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(stop, Math.max(1, Math.min(3000, deadline - Date.now())));
    signal?.addEventListener?.("abort", stop, { once: true });
    child.once("spawn", () => {
      event("started", { pid: child.pid });
      if (signal?.aborted) stop();
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2048) stop();
    });
    child.stderr.on("data", () => {
      failed = true;
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener?.("abort", stop);
      let document;
      try {
        document = JSON.parse(output);
      } catch {
        failed = true;
      }
      event("closed", { pid: child.pid ?? null, exitCode: code, signal: closeSignal, created: document?.created ?? null });
      resolve(!failed && code === 0 && Number.isInteger(document?.driveType) && document.driveType >= 0 && document.driveType <= 6 ? document.driveType : null);
    });
  });
}
export async function qualifySnapshotFileSystem({ root, signal, onProcess, deadline } = {}) {
  try {
    root = fs.realpathSync(root);
    if (/^(?:\\\\|\/\/)/.test(root)) return { status: "unsupported-or-unknown", reasonCode: "UNSUPPORTED_SHARED_STORAGE" };
    const platform = process.platform;
    const driveType = platform === "win32" ? await windowsDriveType(root, { signal, onProcess, deadline }) : undefined;
    const type = platform === "linux" ? fs.statfsSync(root).type : undefined;
    const fstypeName = platform === "darwin" ? darwinFilesystemName(root) : undefined;
    const status = classifySnapshotFileSystem({ platform, driveType, type, fstypeName });
    return {
      status,
      platform,
      ...(driveType !== undefined ? { driveType } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(fstypeName !== undefined ? { fstypeName } : {}),
      ...(status !== "qualified-local" ? { reasonCode: "UNSUPPORTED_OR_UNKNOWN_GC_FILESYSTEM" } : {}),
      boundary: "OS filesystem classification; not proof of every hidden backing layer or noncooperating host",
    };
  } catch (error) {
    return { status: "unsupported-or-unknown", reasonCode: error.code || "GC_FILESYSTEM_UNAVAILABLE" };
  }
}
