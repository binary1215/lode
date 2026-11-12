import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildComputeRequest, buildComputeSuccessResponse, DEFAULT_COMPUTE_LIMITS,
  normalizeComputeLimits, validateComputeResponse,
} from "../scripts/lib/runtime/compute-adapter.mjs";
import {
  buildRepositoryScanInput, executeIncrementalRepositoryScan, scanRepositoryReference,
  validateRepositoryScanExecution,
} from "../scripts/lib/world/repository-scan.mjs";

const MiB = 1024 * 1024;
const request = limits => buildComputeRequest({ operation: "fixture.output-budget.v1", input: {},
  semanticProducer: { name: "synthetic-output-budget", version: "0.1.0" }, limits });
const payloadOverhead = Buffer.byteLength(JSON.stringify({ payload: "" }));
const resultOfSize = bytes => ({ payload: "x".repeat(bytes - payloadOverhead) });

test("compute defaults to 64MiB while explicit lower budgets, hard ceiling and semantic result stay intact", () => {
  assert.equal(DEFAULT_COMPUTE_LIMITS.maxOutputBytes, 64 * MiB);
  const wide = request();
  const narrow = request({ maxOutputBytes: 32 * MiB });
  assert.equal(wide.limits.maxOutputBytes, 64 * MiB);
  assert.equal(narrow.limits.maxOutputBytes, 32 * MiB);
  assert.equal(normalizeComputeLimits({ maxOutputBytes: 2048 }).maxOutputBytes, 2048);
  assert.equal(request({ maxOutputBytes: 512 * MiB }).limits.maxOutputBytes, 512 * MiB);
  assert.throws(() => request({ maxOutputBytes: 512 * MiB + 1 }), { code: "INVALID_COMPUTE_LIMIT" });
  const value = { result: "unchanged", instructionAuthority: false, promotionAuthority: false };
  assert.notEqual(wide.requestId, narrow.requestId, "normalized limits remain part of request identity");
  assert.equal(buildComputeSuccessResponse(wide, value).resultDigest, buildComputeSuccessResponse(narrow, value).resultDigest);
  assert.equal(buildComputeSuccessResponse(wide, value).authorityEffect, "none");
  assert.throws(() => buildComputeSuccessResponse(request({ maxOutputBytes: 2048 }), resultOfSize(2049)), { code: "COMPUTE_OUTPUT_LIMIT" });
});

test("a real 33MiB result succeeds with the default budget and validates its complete envelope and digest", t => {
  const selected = request();
  const response = buildComputeSuccessResponse(selected, resultOfSize(33 * MiB));
  const resultBytes = Buffer.byteLength(JSON.stringify(response.result));
  const responseBytes = Buffer.byteLength(JSON.stringify(response));
  assert.equal(resultBytes, 33 * MiB);
  assert(resultBytes > 32 * MiB && responseBytes < 64 * MiB);
  validateComputeResponse(selected, response);
  t.diagnostic(JSON.stringify({ resultBytes, responseBytes, limitBytes: selected.limits.maxOutputBytes }));
});

test("a real result larger than 64MiB is rejected without a successful response", t => {
  assert.throws(() => buildComputeSuccessResponse(request(), resultOfSize(64 * MiB + 1)), error =>
    error.code === "COMPUTE_OUTPUT_LIMIT" && error.message === "Compute result exceeds maxOutputBytes.");
  t.diagnostic(JSON.stringify({ resultBytes: 64 * MiB + 1, rejectedAt: "result" }));
});

test("a result below 64MiB is still rejected when the complete envelope exceeds 64MiB", t => {
  assert.throws(() => buildComputeSuccessResponse(request(), resultOfSize(64 * MiB - 1)), error =>
    error.code === "COMPUTE_OUTPUT_LIMIT" && error.message === "Compute response exceeds maxOutputBytes.");
  t.diagnostic(JSON.stringify({ resultBytes: 64 * MiB - 1, rejectedAt: "envelope" }));
});

test("an exact 64MiB result cannot consume the bytes reserved by its envelope", t => {
  assert.throws(() => buildComputeSuccessResponse(request(), resultOfSize(64 * MiB)), error =>
    error.code === "COMPUTE_OUTPUT_LIMIT" && error.message === "Compute response exceeds maxOutputBytes.");
  t.diagnostic(JSON.stringify({ resultBytes: 64 * MiB, rejectedAt: "envelope" }));
});

test("incremental scan inherits 64MiB for an actual result above 32MiB while an explicit 32MiB still fails", async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "lode-output-budget-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("lode-output-budget-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  // A tiny generic source with many calls in one long-named scope gives a real
  // large analysis result. No private project, invented scan facts or World writes.
  const scope = `budget_fixture_${"x".repeat(12_000)}`;
  fs.writeFileSync(path.join(root, "sample.mjs"), `function ${scope}() {\n${"  dependency();\n".repeat(3200)}}\n`);
  const input = buildRepositoryScanInput({ projectRoot: root });
  const baseline = scanRepositoryReference(input);
  const previousSnapshot = { repositoryScan: baseline, files: baseline.files, skipped: baseline.skipped };
  const execution = await executeIncrementalRepositoryScan({ projectRoot: root, previousSnapshot });
  const resultBytes = Buffer.byteLength(JSON.stringify(execution.result));
  const responseBytes = Buffer.byteLength(JSON.stringify(execution.response));
  assert(resultBytes > 32 * MiB && responseBytes < 64 * MiB);
  assert.equal(execution.request.limits.maxOutputBytes, 64 * MiB);
  assert.equal(execution.result.scanHash, baseline.scanHash);
  assert.equal(execution.diagnostics.reusedFileCount, 1);
  assert.equal(execution.result.instructionAuthority, false);
  assert.equal(execution.result.promotionAuthority, false);
  validateRepositoryScanExecution(execution, { projectRoot: root });
  await assert.rejects(executeIncrementalRepositoryScan({ projectRoot: root, previousSnapshot,
    limits: { maxOutputBytes: 32 * MiB } }), { code: "COMPUTE_OUTPUT_LIMIT" });
  t.diagnostic(JSON.stringify({ resultBytes, responseBytes, limitBytes: execution.request.limits.maxOutputBytes,
    sourceBytes: baseline.summary.totalBytes, callCount: baseline.summary.callCount,
    reusedFileCount: execution.diagnostics.reusedFileCount, explicit32MiBRejected: true }));
});
