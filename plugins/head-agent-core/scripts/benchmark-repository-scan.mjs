#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeRepositoryScan } from "./lib/repository-scan.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "../benchmarks/repository-scan-v1/basic");
const expectedFile = path.resolve(scriptDirectory, "../benchmarks/repository-scan-v1/expected.json");
const selectedRoot = path.resolve(process.argv[2] || defaultRoot);
const iterations = Number(process.argv[3] || 5);

if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
  console.error("iterations must be an integer from 1 to 100");
  process.exitCode = 2;
} else {
  const records = [];
  for (let index = 0; index < iterations; index += 1) {
    const execution = await executeRepositoryScan({ projectRoot: selectedRoot });
    records.push({
      scanId: execution.result.scanId,
      resultDigest: execution.response.resultDigest,
      elapsedMs: execution.diagnostics.elapsedMs,
    });
  }

  const scanIds = new Set(records.map((record) => record.scanId));
  const resultDigests = new Set(records.map((record) => record.resultDigest));
  if (scanIds.size !== 1 || resultDigests.size !== 1) {
    console.error("repository scan produced nondeterministic semantic output");
    process.exitCode = 1;
  } else {
    if (selectedRoot === defaultRoot) {
      const expected = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
      if (expected.scanId !== records[0].scanId || expected.resultDigest !== records[0].resultDigest) {
        console.error("repository scan no longer matches the reviewed corpus identity");
        process.exitCode = 1;
      }
    }
    const elapsed = records.map((record) => record.elapsedMs).sort((left, right) => left - right);
    const report = {
      schemaVersion: 1,
      kind: "RepositoryScanBenchmarkReport",
      semanticIdentity: {
        scanId: records[0].scanId,
        resultDigest: records[0].resultDigest,
      },
      corpus: path.relative(path.resolve(scriptDirectory, ".."), selectedRoot).replaceAll("\\", "/"),
      iterations,
      diagnostics: {
        minElapsedMs: elapsed[0],
        medianElapsedMs: elapsed[Math.floor(elapsed.length / 2)],
        maxElapsedMs: elapsed.at(-1),
      },
      authorityEffect: "none",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}
