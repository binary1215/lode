// Routing only: the retained implementations still enforce their own contracts.
// Keep discovery and raw CLI/MCP dispatch on this same exact classification.
import { resolveOperation } from "./lode-operation-contract.mjs";
const mutations = Object.freeze([
  ["worker-prepare", "head_bounded_worker_prepare"],
  ["worker-start", "head_bounded_worker_start"],
  ["worker-dispatch", "head_bounded_worker_dispatch"],
  ["worker-execute", null],
  ["worker-apply", "head_bounded_worker_apply_result"],
  ["worker-reconcile", "head_bounded_worker_reconcile"],
  ["worker-job-reconcile", "head_bounded_worker_job_reconcile"],
  ["worker-integrate", "head_worker_integration"],
  ["worker-wave-create", "head_bounded_worker_wave_create"],
  ["worker-wave-seal", "head_bounded_worker_wave_seal"],
  ["worker-wave-abandon", "head_bounded_worker_wave_abandon"],
].map(Object.freeze));

export function requireSurface(surface) {
  if (surface !== "ordinary" && surface !== "managed-maintenance") throw new Error("Unknown HEAD command surface.");
  return surface;
}

export function isManagedMutation(name) {
  const semantic = resolveOperation(name)?.semanticName ?? name;
  return typeof semantic === "string" && mutations.some(pair => pair.includes(semantic));
}

export function requireOperationSurface(name, surface = "ordinary", { workerBound = false } = {}) {
  requireSurface(surface);
  if (surface === "ordinary" && (isManagedMutation(name) || workerBound)) {
    const error = new Error(`${name} is not available on the ordinary command surface. No operation was started; ordinary work and existing-work diagnostics remain available.`);
    error.code = "MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE";
    throw error;
  }
}

export function commandEntry(argv) {
  return argv[0] === "managed-maintenance" || argv[0] === "managed"
    ? { surface: "managed-maintenance", argv: argv.slice(1) }
    : { surface: "ordinary", argv };
}
