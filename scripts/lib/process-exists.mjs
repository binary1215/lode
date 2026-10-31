// Whether a pid still names a process. EPERM means it exists and this user
// cannot signal it. scripts/verify-process-supervisor.mjs uses this same check.
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}
