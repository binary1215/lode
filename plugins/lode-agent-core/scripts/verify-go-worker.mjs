#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeComputeOperation, verifyComputeAdapterConformance } from "./lib/compute-adapter.mjs";
import {
  createWorkerHealthReferenceAdapter,
  GoWorkerComputeAdapter,
  resolveVerifiedGoWorker,
  WORKER_HEALTH_INPUT,
  WORKER_HEALTH_OPERATION,
  WORKER_HEALTH_SEMANTIC_PRODUCER,
  WORKER_LIFECYCLE_INPUT,
  WORKER_LIFECYCLE_OPERATION,
  WORKER_LIFECYCLE_SEMANTIC_PRODUCER,
} from "./lib/go-worker-adapter.mjs";
import {
  buildRepositoryScanInput,
  createRepositoryScanReferenceAdapter,
  REPOSITORY_SCAN_OPERATION,
  REPOSITORY_SCAN_SEMANTIC_PRODUCER,
  validateRepositoryScanResult,
} from "./lib/repository-scan.mjs";
import { buildRepositorySourceScope } from "./lib/repository-source-scope.mjs";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("arguments must be --name value pairs");
    const name = key.slice(2);
    if (!["plugin-root", "repository-root"].includes(name) || result[name]) throw new Error(`unsupported or duplicate argument: ${key}`);
    result[name] = value;
  }
  if (!result["plugin-root"]) throw new Error("usage: verify-go-worker.mjs --plugin-root <path> [--repository-root <path>]");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  return {
    pluginRoot: path.resolve(result["plugin-root"]),
    repositoryRoot: path.resolve(result["repository-root"] || path.join(scriptDirectory, "../benchmarks/repository-scan-v1/basic")),
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForNoOwnedProcesses(adapter) {
  const deadline = Date.now() + 2_000;
  while (adapter.activeProcessIds().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (adapter.activeProcessIds().length) throw new Error(`Go worker PIDs remained after cancellation: ${adapter.activeProcessIds().join(",")}`);
}

try {
  const { pluginRoot, repositoryRoot } = parseArguments(process.argv.slice(2));
  const referenceAdapter = createWorkerHealthReferenceAdapter();
  const repositoryReferenceAdapter = createRepositoryScanReferenceAdapter();
  const nativeSelection = resolveVerifiedGoWorker({ pluginRoot });
  const candidateAdapter = new GoWorkerComputeAdapter({ pluginRoot, fallbackAdapter: repositoryReferenceAdapter });
  const fixture = {
    name: "worker-health",
    operation: WORKER_HEALTH_OPERATION,
    input: WORKER_HEALTH_INPUT,
    semanticProducer: WORKER_HEALTH_SEMANTIC_PRODUCER,
  };
  const conformance = await verifyComputeAdapterConformance({ referenceAdapter, candidateAdapter, fixtures: [fixture] });
  const execution = await executeComputeOperation({
    adapter: candidateAdapter,
    operation: WORKER_HEALTH_OPERATION,
    input: WORKER_HEALTH_INPUT,
    semanticProducer: WORKER_HEALTH_SEMANTIC_PRODUCER,
  });
  if (execution.diagnostics.backend !== "go-worker" || execution.diagnostics.fallbackUsed !== false) throw new Error("verification used fallback instead of the Go worker");
  if (execution.result.status !== "ready" || execution.result.instructionAuthority !== false
    || execution.result.promotionAuthority !== false || execution.result.controlAuthority !== false) throw new Error("Go worker health result violates its authority contract");
  if (processExists(execution.diagnostics.workerPid)) throw new Error(`Go worker PID ${execution.diagnostics.workerPid} remained alive after response`);
  let repositoryConformance = null;
  let repositoryExecution = null;
  if (nativeSelection.manifest.operations.includes(REPOSITORY_SCAN_OPERATION)) {
    const input = buildRepositoryScanInput({ projectRoot: repositoryRoot });
    const managedInput = buildRepositoryScanInput({ projectRoot: repositoryRoot, managedRootFiles: ["README.md"] });
    const scopedInput = buildRepositoryScanInput({
      projectRoot: repositoryRoot,
      sourceScope: buildRepositorySourceScope({ includeRoots: ["src"], excludeRoots: ["src/tool.py"] }),
    });
    const missingInput = buildRepositoryScanInput({ projectRoot: path.join(repositoryRoot, "missing-root") });
    repositoryConformance = await verifyComputeAdapterConformance({
      referenceAdapter: repositoryReferenceAdapter,
      candidateAdapter,
      fixtures: [
        { name: "repository-scan-basic", operation: REPOSITORY_SCAN_OPERATION, input, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER },
        { name: "repository-scan-file-limit", operation: REPOSITORY_SCAN_OPERATION, input, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER, limits: { maxFiles: 1 } },
        { name: "repository-scan-managed-projection", operation: REPOSITORY_SCAN_OPERATION, input: managedInput, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER },
        { name: "repository-scan-source-scope", operation: REPOSITORY_SCAN_OPERATION, input: scopedInput, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER },
        { name: "repository-scan-missing-root", operation: REPOSITORY_SCAN_OPERATION, input: missingInput, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER },
        { name: "repository-scan-total-byte-limit", operation: REPOSITORY_SCAN_OPERATION, input, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER, limits: { maxTotalBytes: 1 } },
        { name: "repository-scan-skip-large", operation: REPOSITORY_SCAN_OPERATION, input, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER, limits: { maxFileBytes: 1 } },
      ],
    });
    repositoryExecution = await executeComputeOperation({
      adapter: candidateAdapter,
      operation: REPOSITORY_SCAN_OPERATION,
      input,
      semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER,
    });
    if (repositoryExecution.diagnostics.backend !== "go-worker" || repositoryExecution.diagnostics.fallbackUsed !== false) {
      throw new Error("repository scan verification used fallback instead of the Go worker");
    }
    validateRepositoryScanResult(repositoryExecution.result);
    if (processExists(repositoryExecution.diagnostics.workerPid)) throw new Error(`Go worker PID ${repositoryExecution.diagnostics.workerPid} remained alive after repository scan`);
  }
  let cancellation = "not-advertised";
  if (candidateAdapter.describe().supportedOperations.includes(WORKER_LIFECYCLE_OPERATION)) {
    try {
      await executeComputeOperation({
        adapter: candidateAdapter,
        operation: WORKER_LIFECYCLE_OPERATION,
        input: WORKER_LIFECYCLE_INPUT,
        semanticProducer: WORKER_LIFECYCLE_SEMANTIC_PRODUCER,
        limits: { timeoutMs: 10 },
      });
      throw new Error("lifecycle fixture unexpectedly completed");
    } catch (error) {
      if (error.code !== "COMPUTE_TIMEOUT") throw error;
    }
    await waitForNoOwnedProcesses(candidateAdapter);
    cancellation = "verified-timeout-and-pid-exit";
  }
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    operation: WORKER_HEALTH_OPERATION,
    conformanceReportId: conformance.conformanceReportId,
    resultDigest: execution.response.resultDigest,
    repositoryScan: repositoryExecution ? {
      conformanceReportId: repositoryConformance.conformanceReportId,
      fixtureCount: repositoryConformance.fixtures.length,
      scanId: repositoryExecution.result.scanId,
      resultDigest: repositoryExecution.response.resultDigest,
      backend: repositoryExecution.diagnostics.backend,
    } : { status: "not-advertised" },
    workerRelativePath: execution.diagnostics.workerRelativePath,
    workerSha256: execution.diagnostics.workerSha256,
    processCleanup: "verified-exited",
    cancellation,
    authorityEffect: "none",
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
