import { runBoundedWorkerJobOwner } from "./lib/worker/bounded-worker-job.mjs";

// The owner's stderr is its local job diagnostic (stderr.bin). A failure names
// the failing file operation and where it came from, so an intermittent
// filesystem error (for example a Windows EPERM or ENOENT) can be located.
function ownerFailureDiagnostic(error) {
  const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : undefined);
  return {
    message: text(error?.message, 1000),
    syscall: text(error?.syscall, 64),
    path: text(error?.path, 1000),
    dest: text(error?.dest, 1000),
    errno: Number.isInteger(error?.errno) ? error.errno : undefined,
    stack:
      typeof error?.stack === "string"
        ? error.stack
            .split("\n")
            .slice(1, 16)
            .map((line) => line.trim().slice(0, 300))
        : undefined,
  };
}

const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
  const result = await runBoundedWorkerJobOwner(process.argv[2], {
    signal: controller.signal,
    onProcess: (event) => process.stderr.write(`${JSON.stringify({ workerProcess: event })}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code || "WORKER_JOB_OWNER_FAILED", diagnostic: ownerFailureDiagnostic(error) })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
