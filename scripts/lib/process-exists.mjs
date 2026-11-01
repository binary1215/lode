import fs from "node:fs";

// Whether a pid still names a process. EPERM means it exists and this user
// cannot signal it. scripts/verify-process-supervisor.mjs uses this same check.
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

// Linux starttime from /proc/pid/stat (field 22). A reused pid has a different
// value. Other platforms have no portable read here, so callers treat a missing
// id as "unknown" and do not reclaim a live pid from time alone.
export function processStartId(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const start = stat.slice(end + 2).split(" ")[19];
    return /^[0-9]+$/u.test(start || "") ? start : null;
  } catch { return null; }
}
