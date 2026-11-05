import { runBoundedWorkerJobOwner } from "./lib/bounded-worker-job.mjs";

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
  process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code || "WORKER_JOB_OWNER_FAILED" })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
