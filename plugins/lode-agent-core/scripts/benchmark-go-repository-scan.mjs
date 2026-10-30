#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeComputeOperation, verifyComputeAdapterConformance } from "./lib/compute-adapter.mjs";
import { GoWorkerComputeAdapter } from "./lib/go-worker-adapter.mjs";
import {
  buildRepositoryScanInput,
  createRepositoryScanReferenceAdapter,
  REPOSITORY_SCAN_OPERATION,
  REPOSITORY_SCAN_SEMANTIC_PRODUCER,
} from "./lib/repository-scan.mjs";

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("arguments must be --name value pairs");
    const name = key.slice(2);
    if (!["plugin-root", "repository-root", "iterations"].includes(name) || result[name]) throw new Error(`unsupported or duplicate argument: ${key}`);
    result[name] = value;
  }
  if (!result["plugin-root"]) throw new Error("--plugin-root is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const iterations = Number(result.iterations || 10);
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 100) throw new Error("--iterations must be an integer from 3 to 100");
  return {
    pluginRoot: path.resolve(result["plugin-root"]),
    repositoryRoot: path.resolve(result["repository-root"] || path.join(scriptDirectory, "../benchmarks/repository-scan-v1/basic")),
    iterations,
  };
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function execute(adapter, input) {
  return executeComputeOperation({
    adapter,
    operation: REPOSITORY_SCAN_OPERATION,
    input,
    semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER,
  });
}

try {
  const { pluginRoot, repositoryRoot, iterations } = parseArguments(process.argv.slice(2));
  const input = buildRepositoryScanInput({ projectRoot: repositoryRoot });
  const referenceAdapter = createRepositoryScanReferenceAdapter();
  const candidateAdapter = new GoWorkerComputeAdapter({ pluginRoot, fallbackAdapter: referenceAdapter });
  const conformance = await verifyComputeAdapterConformance({
    referenceAdapter,
    candidateAdapter,
    fixtures: [{ name: "benchmark-repository", operation: REPOSITORY_SCAN_OPERATION, input, semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER }],
  });

  for (let index = 0; index < 2; index += 1) {
    await execute(referenceAdapter, input);
    const warm = await execute(candidateAdapter, input);
    if (warm.diagnostics.backend !== "go-worker" || warm.diagnostics.fallbackUsed !== false) throw new Error("Go benchmark used JavaScript fallback");
  }

  const javascriptElapsedMs = [];
  const goElapsedMs = [];
  let semanticIdentity = null;
  for (let index = 0; index < iterations; index += 1) {
    const first = index % 2 === 0 ? "javascript" : "go";
    for (const backend of [first, first === "javascript" ? "go" : "javascript"]) {
      const execution = await execute(backend === "javascript" ? referenceAdapter : candidateAdapter, input);
      if (backend === "go" && (execution.diagnostics.backend !== "go-worker" || execution.diagnostics.fallbackUsed !== false)) {
        throw new Error("Go benchmark used JavaScript fallback");
      }
      (backend === "go" ? goElapsedMs : javascriptElapsedMs).push(execution.diagnostics.elapsedMs);
      semanticIdentity ||= { scanId: execution.result.scanId, resultDigest: execution.response.resultDigest };
      if (execution.result.scanId !== semanticIdentity.scanId || execution.response.resultDigest !== semanticIdentity.resultDigest) {
        throw new Error("benchmark semantic identity drifted between backends or iterations");
      }
    }
  }

  const javascriptMedianMs = median(javascriptElapsedMs);
  const goMedianMs = median(goElapsedMs);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "GoRepositoryScanBenchmarkReport",
    conformanceReportId: conformance.conformanceReportId,
    semanticIdentity,
    corpus: path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), repositoryRoot).replaceAll("\\", "/") || ".",
    iterations,
    diagnostics: {
      javascriptMedianMs,
      goMedianMs,
      speedupRatio: javascriptMedianMs / goMedianMs,
      measuredImprovement: goMedianMs < javascriptMedianMs,
    },
    authorityEffect: "none",
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
