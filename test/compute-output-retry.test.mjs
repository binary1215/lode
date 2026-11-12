import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildComputeRequest, buildComputeErrorResponse, buildComputeSuccessResponse,
  executeComputeOperation, JsReferenceComputeAdapter, validateComputeResponse,
} from "../scripts/lib/runtime/compute-adapter.mjs";
import { GoWorkerComputeAdapter } from "../scripts/lib/worker/go-worker-adapter.mjs";
import { buildRepositoryScanInput, executeIncrementalRepositoryScan, executeRepositoryScan,
  scanRepositoryReference, validateRepositoryScanExecution } from "../scripts/lib/world/repository-scan.mjs";

const MiB = 1024 * 1024;
const budgets = [64, 128, 256, 512].map(x => x * MiB);
const operation = "fixture.output-retry.v1";
const semanticProducer = { name: "generic-retry-fixture", version: "0.1.0" };
const overflow = request => buildComputeErrorResponse(request, [{ code: "COMPUTE_OUTPUT_LIMIT", message: "Compute response exceeds maxOutputBytes." }]);
function fake(execute) {
  const base = new JsReferenceComputeAdapter({ operations: { [operation]: () => ({ value: "complete" }) } });
  return { describe: () => base.describe(), execute };
}
const run = (adapter, extra = {}) => executeComputeOperation({ adapter, operation, input: { anchor: "original" }, semanticProducer, ...extra });

test("default output-only failures use exactly 64/128/256/512 and expose bounded exhaustion", async () => {
  const requests = [];
  await assert.rejects(run(fake(request => { requests.push(request); return overflow(request); })), error => {
    assert.equal(error.code, "COMPUTE_OPERATION_FAILED");
    assert.match(error.message, /512 MiB.*3 retries/);
    assert.deepEqual(error.details.outputBudgetAttempts, budgets);
    assert.equal(error.details.outputRetryCount, 3);
    assert.equal(error.details.errors[0].code, "COMPUTE_OUTPUT_LIMIT");
    return true;
  });
  assert.deepEqual(requests.map(x => x.limits.maxOutputBytes), budgets);
  assert.equal(new Set(requests.map(x => x.requestId)).size, 4);
  assert.equal(new Set(requests.map(x => x.inputDigest)).size, 1);
});

test("third retry succeeds with original immutable input, producer and all non-output limits", async () => {
  const input = { anchor: "original" }, limits = { maxFiles: 123, timeoutMs: 1000 };
  const producer = { ...semanticProducer };
  const requests = [];
  let active = 0, maxActive = 0;
  const adapter = fake(async request => {
    maxActive = Math.max(maxActive, ++active);
    requests.push(request);
    await Promise.resolve();
    active--;
    input.anchor = "changed"; limits.maxFiles = 1; limits.timeoutMs = 10; producer.version = "mutated";
    return requests.length < 4 ? overflow(request) : buildComputeSuccessResponse(request, { value: "complete" });
  });
  const result = await run(adapter, { input, limits, semanticProducer: producer });
  assert.deepEqual(result.diagnostics.outputBudgetAttempts, budgets);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  for (const request of requests) {
    assert(Object.isFrozen(request.input));
    assert.equal(request.input.anchor, "original");
    assert.equal(request.limits.maxFiles, 123);
    assert.equal(request.limits.timeoutMs, 1000);
    assert.equal(request.semanticProducer.version, "0.1.0");
  }
  assert.equal(result.response.resultDigest, buildComputeSuccessResponse(requests[0], { value: "complete" }).resultDigest);
});

test("explicit output budgets including null/default/512MiB never automatically grow", async () => {
  for (const maxOutputBytes of [2048, 64 * MiB, 128 * MiB, 512 * MiB, null]) {
    const seen = [];
    await assert.rejects(run(fake(request => { seen.push(request.limits.maxOutputBytes); return overflow(request); }), { limits: { maxOutputBytes } }), error => {
      assert.equal(error.details.outputRetryCount, 0);
      assert.match(error.message, /explicit.*disabled/);
      return true;
    });
    assert.deepEqual(seen, [maxOutputBytes ?? 64 * MiB]);
  }
});

test("permission, runtime, crash, mixed errors, tampered identity/digest/authority and oversized success never trigger retry", async () => {
  for (const code of ["COMPUTE_CANCELLED", "COMPUTE_TIMEOUT", "COMPUTE_OUTPUT_RUNTIME_LIMIT", "PERMISSION_DENIED", "GO_WORKER_CRASHED", "GO_WORKER_STDOUT_LIMIT"]) {
    let calls = 0;
    await assert.rejects(run(fake(request => { calls++; return buildComputeErrorResponse(request, [{ code, message: "fixture failure" }]); })));
    assert.equal(calls, 1, code);
  }
  for (const mutate of [
    request => buildComputeErrorResponse(request, [{ code: "COMPUTE_OUTPUT_LIMIT", message: "overflow" }, { code: "PERMISSION_DENIED", message: "denied" }]),
    request => ({ ...overflow(request), requestId: "compute-request-000000000000000000000000" }),
    request => ({ ...buildComputeSuccessResponse(request, {}), resultDigest: "0".repeat(64) }),
    request => ({ ...buildComputeSuccessResponse(request, {}), result: { instructionAuthority: true } }),
    request => ({ ...buildComputeSuccessResponse(request, {}), result: { payload: "x".repeat(4096), canonicalAuthority: true } }),
  ]) {
    let calls = 0;
    await assert.rejects(run(fake(request => { calls++; return mutate(request); }), { limits: { maxOutputBytes: 2048 } }));
    assert.equal(calls, 1);
  }
  let thrown = 0;
  await assert.rejects(run(fake(() => { thrown++; throw Object.assign(new Error("stdout broken"), { code: "COMPUTE_OUTPUT_LIMIT" }); })), { code: "COMPUTE_OUTPUT_LIMIT" });
  assert.equal(thrown, 1, "an unvalidated thrown error is not a protocol retry instruction");
});

test("caller cancellation and a single total deadline prevent later retries", async () => {
  const controller = new AbortController(); let cancelledCalls = 0;
  await assert.rejects(run(fake(request => { cancelledCalls++; controller.abort(); return overflow(request); }), { signal: controller.signal }), { code: "COMPUTE_CANCELLED" });
  assert.equal(cancelledCalls, 1);
  let timedCalls = 0;
  await assert.rejects(run(fake(async request => { timedCalls++; await new Promise(resolve => setTimeout(resolve, 50)); return overflow(request); }), { limits: { timeoutMs: 80 } }), { code: "COMPUTE_TIMEOUT" });
  assert.equal(timedCalls, 2, "deadline must not reset on the second attempt");
  // Let the cooperative toy adapter's already-started delay finish; no child or
  // network effect exists, and no next attempt is allowed after timeout.
  await new Promise(resolve => setTimeout(resolve, 30));
  let syncCalls = 0;
  await assert.rejects(run(fake(request => { syncCalls++; const until = performance.now() + 20; while (performance.now() < until) {} return overflow(request); }), { limits: { timeoutMs: 10 } }), { code: "COMPUTE_TIMEOUT" });
  assert.equal(syncCalls, 1);
  const early = new AbortController();
  const add = early.signal.addEventListener.bind(early.signal);
  early.signal.addEventListener = (...args) => { const until = performance.now() + 20; while (performance.now() < until) {} return add(...args); };
  let earlyCalls = 0;
  await assert.rejects(run(fake(request => { earlyCalls++; return overflow(request); }), { signal: early.signal, limits: { timeoutMs: 10 } }), error => {
    assert.equal(error.code, "COMPUTE_TIMEOUT");
    assert.deepEqual(error.details.outputBudgetAttempts, []);
    assert.equal(error.details.outputRetryCount, 0);
    return true;
  });
  assert.equal(earlyCalls, 0);
});

test("real 65MiB JS result is computed once and re-enveloped completely at 128MiB through Go fallback", async t => {
  let computes = 0;
  const adapter = new GoWorkerComputeAdapter({ pluginRoot: path.join(os.tmpdir(), "lode-no-installed-fixture-worker"),
    fallbackAdapter: new JsReferenceComputeAdapter({ operations: { [operation]: () => { computes++; return { payload: computes === 1 ? "x".repeat(65 * MiB) : "new observation" }; } } }) });
  const result = await run(adapter);
  assert.equal(computes, 1);
  assert.deepEqual(result.diagnostics.outputBudgetAttempts, budgets.slice(0, 2));
  assert.equal(result.diagnostics.fallbackUsed, true);
  assert.equal(result.response.result.payload.length, 65 * MiB);
  validateComputeResponse(result.request, result.response);
  t.diagnostic(JSON.stringify({ resultBytes: Buffer.byteLength(JSON.stringify(result.result)), responseBytes: Buffer.byteLength(JSON.stringify(result.response)), computes, budgets: result.diagnostics.outputBudgetAttempts }));
  const next = await run(adapter);
  assert.equal(computes, 2, "a new invocation must not retain the previous result");
  assert.equal(next.result.payload, "new observation");
  assert.deepEqual(next.diagnostics.outputBudgetAttempts, [64 * MiB]);
});

test("real 129MiB UTF8 result uses 256MiB without four scans or character-count budgeting", async t => {
  let computes = 0;
  const result = await run(new JsReferenceComputeAdapter({ operations: { [operation]: () => { computes++; return { payload: "가".repeat(43 * MiB) }; } } }));
  assert.equal(computes, 1);
  assert.deepEqual(result.diagnostics.outputBudgetAttempts, budgets.slice(0, 3));
  const resultBytes = Buffer.byteLength(JSON.stringify(result.result));
  assert(resultBytes > 128 * MiB);
  assert.equal(result.result.payload.length, 43 * MiB);
  validateComputeResponse(result.request, result.response);
  t.diagnostic(JSON.stringify({ resultBytes, responseBytes: Buffer.byteLength(JSON.stringify(result.response)), utf16Units: result.result.payload.length, computes, budgets: result.diagnostics.outputBudgetAttempts }));
});

test("incremental and initial scans retain complete captured facts across output retry and do not repeat source reads", async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "lode-retry-scan-"));
  t.after(() => { assert.equal(path.dirname(root), parent); assert(path.basename(root).startsWith("lode-retry-scan-")); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceFile = path.join(root, "generic.mjs");
  const source = `function fixture_${"x".repeat(12000)}() {\n${"  dependency();\n".repeat(6000)}}\n`;
  fs.writeFileSync(sourceFile, source);
  const input = buildRepositoryScanInput({ projectRoot: root });
  const baseline = scanRepositoryReference(input);
  const snapshot = { repositoryScan: baseline, files: baseline.files, skipped: baseline.skipped };
  const originalRead = fs.readFileSync; let reads = 0;
  fs.readFileSync = function(file, ...args) { const result = originalRead.call(this, file, ...args); if (path.resolve(String(file)) === sourceFile) { reads++; fs.writeFileSync(sourceFile, "// changed after captured read\n"); } return result; };
  let incremental;
  try { incremental = await executeIncrementalRepositoryScan({ projectRoot: root, previousSnapshot: snapshot }); } finally { fs.readFileSync = originalRead; }
  assert.equal(reads, 1);
  assert.deepEqual(incremental.diagnostics.outputBudgetAttempts, budgets.slice(0, 2));
  assert.equal(incremental.result.scanHash, baseline.scanHash, "captured facts are not replaced with a later read");
  validateRepositoryScanExecution(incremental, { projectRoot: root });
  assert.notEqual(fs.readFileSync(sourceFile, "utf8"), source, "the later source change remains observable, not merged into old facts");
  fs.writeFileSync(sourceFile, source); reads = 0;
  fs.readFileSync = function(file, ...args) { const result = originalRead.call(this, file, ...args); if (path.resolve(String(file)) === sourceFile) reads++; return result; };
  let initial;
  try { initial = await executeRepositoryScan({ projectRoot: root, adapter: new GoWorkerComputeAdapter({ pluginRoot: root, fallbackAdapter: (await import("../scripts/lib/world/repository-scan.mjs")).createRepositoryScanReferenceAdapter() }) }); } finally { fs.readFileSync = originalRead; }
  assert.equal(reads, 1);
  assert.equal(initial.result.scanHash, baseline.scanHash);
  assert.deepEqual(initial.diagnostics.outputBudgetAttempts, budgets.slice(0, 2));
  validateRepositoryScanExecution(initial, { projectRoot: root });
  assert.deepEqual(fs.readdirSync(root), ["generic.mjs"], "no World, documents, retry artifacts or project records are written");
  t.diagnostic(JSON.stringify({ resultBytes: Buffer.byteLength(JSON.stringify(initial.result)), incrementalReads: 1, initialReads: reads, files: fs.readdirSync(root), budgets: initial.diagnostics.outputBudgetAttempts }));
});
