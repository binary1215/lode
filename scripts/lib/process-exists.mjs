import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Whether a pid still names a process. EPERM means it exists and this user
// cannot signal it. scripts/verify-process-supervisor.mjs uses this same check.
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

// Linux starttime from /proc/pid/stat (field 22). macOS uses `ps -o lstart=`.
// Windows has no similarly cheap read here; a missing id is unverified and the
// claim layer must not hold that pid forever.
export function processStartId(pid, { platform = process.platform, readFile = fs.readFileSync, spawnSyncImpl = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (platform === "linux") {
    try {
      const stat = readFile(`/proc/${pid}/stat`, "utf8");
      const text = Buffer.isBuffer(stat) ? stat.toString("utf8") : String(stat);
      const end = text.lastIndexOf(")");
      if (end < 0) return null;
      const start = text.slice(end + 2).split(" ")[19];
      return /^[0-9]+$/u.test(start || "") ? start : null;
    } catch { return null; }
  }
  if (platform === "darwin") {
    try {
      const result = spawnSyncImpl("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1500, shell: false });
      if (!result || result.status !== 0) return null;
      const text = String(result.stdout || "").trim();
      return text && !/[\0\r\n]/u.test(text) ? text : null;
    } catch { return null; }
  }
  return null;
}
