import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSourceFile, extractSourceDependencies, extractSourceSymbols, extractSemanticSourceFacts } from "../scripts/lib/world/source-analysis.mjs";
import { buildRepositoryScanInput, scanRepositoryReference, inspectRepositoryScanForWorld, validateRepositoryScanResult,
  inspectRepositoryScanFreshness, executeIncrementalRepositoryScan, validateRepositoryScanExecution } from "../scripts/lib/world/repository-scan.mjs";
import { buildComputeRequest, buildComputeSuccessResponse, validateComputeResponse } from "../scripts/lib/runtime/compute-adapter.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-perf-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.mjs"), "export function a() { return b(); }\n");
  fs.writeFileSync(path.join(root, "src/b.py"), "def b():\n    return relay()\n");
  const input = buildRepositoryScanInput({ projectRoot: root }), before = scanRepositoryReference(input);
  return { root, input, before, options: { projectRoot: root } };
}

test("private joint analysis preserves individual APIs across newlines, scopes, aliases and text languages", () => {
  const cases = [
    ["javascript", "import { relay as call } from './relay.mjs';\nfunction outer() { function inner() { call(); } inner(); }\n"],
    ["javascript", "const f = (v) => relay(v);\r\nfunction same() { return f(); }\r\nfunction same() { return f(); }\n"],
    ["python", "class A:\n    def f(self):\n        def g():\n            return call()\n        return g()\n"],
    ["markdown", "# Header\r\n## Detail\n## Detail\n"], ["json", '{"answer":42}'],
    ["javascript", "\n\nfunction f() {\n call();\n}\n"], ["javascript", "function f() { call(); }\rfunction g() { f(); }"],
    ["javascript", ""], ["javascript", "\ud800\nfunction f() { call(); }\n"],
  ];
  for (const [language, text] of cases) assert.deepEqual(analyzeSourceFile(text, language, "sample"), {
    symbols: extractSourceSymbols(text, language), dependencies: extractSourceDependencies(text, language, "sample"),
    semanticFacts: extractSemanticSourceFacts(text, language),
  });
});

test("caller evidence is not truncated to the public 200 symbol display limit", () => {
  const text = Array.from({ length: 305 }, (_, i) => `function f${i}() { return relay(); }`).join("\n");
  const result = analyzeSourceFile(text, "javascript", "sample.mjs");
  assert.equal(result.symbols.length, 200);
  assert.equal(result.semanticFacts.calls.at(-1).callerQualifiedName, "f304");
  assert.deepEqual(result.semanticFacts, extractSemanticSourceFacts(text, "javascript"));
});

test("caller limit remains 10000 and does not turn truncation into invented caller evidence", () => {
  const text = Array.from({ length: 10_002 }, (_, i) => `function f${i}() { relay(); }`).join("\n");
  const result = analyzeSourceFile(text, "javascript", "sample.mjs");
  assert.equal(result.symbols.length, 200);
  const calls = result.semanticFacts.calls;
  assert.equal(calls[9999].callerQualifiedName, "f9999");
  assert.equal(calls[10000].callerQualifiedName, null);
  assert.equal(calls[10001].callerIdentityAmbiguous, false);
});

test("UTF-16 comment masking preserves astral and lone-surrogate source offsets", () => {
  for (const prefix of ["🧭", "\ud800", "\udfff", "🧭🧭"]) {
    for (const newline of ["\n", "\r\n"]) {
      const js = analyzeSourceFile(`// ${prefix}${newline}function alpha() { return beta(); }${newline}`, "javascript", "sample.mjs");
      assert.equal(js.symbols[0].line, 2); assert.equal(js.symbols[0].endLine, 2);
      assert.equal(js.semanticFacts.calls[0].line, 2); assert.equal(js.semanticFacts.calls[0].callerQualifiedName, "alpha");
      const py = analyzeSourceFile(`# ${prefix}${newline}def alpha():${newline}    return beta()${newline}`, "python", "sample.py");
      assert.equal(py.symbols[0].line, 2); assert.equal(py.symbols[0].signature, "def alpha():");
      assert.equal(py.semanticFacts.calls[0].line, 3); assert.equal(py.semanticFacts.calls[0].callerQualifiedName, "alpha");
    }
  }
});

test("historical source producer remains readable but is reanalyzed rather than reused", async t => {
  const f = fixture(t), old = structuredClone(f.before);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const identify = value => {
    const { scanId, scanHash, ...payload } = value;
    const hash = crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
    return { ...payload, scanId: `repository-scan-${hash.slice(0, 24)}`, scanHash: hash };
  };
  old.sourceAnalysisVersion = "0.3.0";
  const historical = identify(old), original = JSON.stringify(historical);
  assert.doesNotThrow(() => validateRepositoryScanResult(historical));
  const { files, skipped, ...repositoryScan } = historical;
  const result = await executeIncrementalRepositoryScan({ ...f.options, previousSnapshot: { files, skipped, repositoryScan } });
  assert.equal(result.result.sourceAnalysisVersion, "0.3.1");
  assert.equal(result.diagnostics.reusedFileCount, 0); assert.equal(result.diagnostics.analyzedFileCount, files.length);
  assert.deepEqual(result.result.files, historical.files); assert.notEqual(result.result.scanId, historical.scanId);
  assert.equal(JSON.stringify(historical), original);
  assert.throws(() => validateRepositoryScanResult(identify({ ...historical, sourceAnalysisVersion: "99.0.0" })), { code: "INVALID_REPOSITORY_SCAN_RESULT" });
});

test("World synchronous observation reads each included source once and matches full scan after edit/rename/add/delete", t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.root, "src/b.py"), path.join(f.root, "src/renamed.py"));
  fs.appendFileSync(path.join(f.root, "src/a.mjs"), "export function next() { return a(); }\n");
  fs.writeFileSync(path.join(f.root, "src/added.md"), "# New evidence\n");
  const reads = [], original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) { reads.push(file); return original.call(this, file, ...args); });
  const result = inspectRepositoryScanForWorld(f.options, f.before);
  assert(!(result instanceof Promise));
  assert.equal(reads.filter(file => typeof file === "string" && file.includes(`${path.sep}src${path.sep}`)).length, 3);
  assert.deepEqual(result.freshness.changes, { added: ["src/added.md", "src/renamed.py"], changed: ["src/a.mjs"], removed: ["src/b.py"] });
  assert.deepEqual(result.scan, scanRepositoryReference(f.input));
  assert.deepEqual(inspectRepositoryScanFreshness({ ...f.options, storedFiles: result.scan.files }).status, "unchanged");
});

test("one request pins observed bytes without claiming atomic repository currentness", t => {
  const f = fixture(t), file = path.join(f.root, "src/a.mjs"), original = fs.readFileSync;
  let first = true;
  t.mock.method(fs, "readFileSync", function(target, ...args) {
    const value = original.call(this, target, ...args);
    if (target === file && first) { first = false; fs.writeFileSync(file, "export function changedLater() {}\n"); }
    return value;
  });
  const observed = inspectRepositoryScanForWorld(f.options, f.before);
  assert.equal(observed.freshness.status, "unchanged");
  assert.equal(inspectRepositoryScanFreshness({ ...f.options, storedFiles: f.before.files }).status, "changed");
});

test("changed World consumer rejects tampered stored analysis and preserves file/byte limits", t => {
  const f = fixture(t), tampered = structuredClone(f.before);
  tampered.files[0].semanticFacts.calls[0].callee = "forged";
  fs.appendFileSync(path.join(f.root, "src/b.py"), "\n# changed\n");
  assert.throws(() => inspectRepositoryScanForWorld(f.options, tampered), { code: "REPOSITORY_SCAN_DIGEST_MISMATCH" });
  assert.throws(() => inspectRepositoryScanForWorld({ ...f.options, limits: { maxFiles: 1 } }, f.before), { code: "REPOSITORY_SCAN_FILE_LIMIT" });
  assert.throws(() => inspectRepositoryScanForWorld({ ...f.options, limits: { maxTotalBytes: 1 } }, f.before), { code: "REPOSITORY_SCAN_TOTAL_BYTES_LIMIT" });
});

test("local immutable incremental construction does not weaken external execution verification", async t => {
  const f = fixture(t), { files, skipped, ...repositoryScan } = f.before;
  const result = await executeIncrementalRepositoryScan({ ...f.options, previousSnapshot: { files, skipped, repositoryScan } });
  assert(Object.isFrozen(result.result.files[0].semanticFacts.calls));
  assert.strictEqual(result.result, result.response.result);
  assert.throws(() => { result.result.files[0].symbols[0].name = "forged"; }, TypeError);
  assert.doesNotThrow(() => validateRepositoryScanExecution(result, f.options));
  const changed = structuredClone(result); changed.result.files[0].symbols[0].name = "forged";
  assert.throws(() => validateRepositoryScanExecution(changed, f.options));
  const mismatch = structuredClone(result); mismatch.response.semanticProducer.version = "999.0.0";
  assert.throws(() => validateRepositoryScanExecution(mismatch, f.options));
});

test("caller mutation during source reads cannot replace owned previous analysis", async t => {
  const f = fixture(t), { files, skipped, ...repositoryScan } = structuredClone(f.before);
  const original = fs.readFileSync; let changed = false;
  t.mock.method(fs, "readFileSync", function(...args) {
    if (!changed) { changed = true; files[0].symbols[0].name = "forged-during-read"; }
    return original.apply(this, args);
  });
  const execution = await executeIncrementalRepositoryScan({ ...f.options, previousSnapshot: { files, skipped, repositoryScan } });
  assert.equal(files[0].symbols[0].name, "forged-during-read");
  assert.notEqual(execution.result.files[0].symbols[0].name, "forged-during-read");
  assert.deepEqual(execution.result.files, f.before.files);
});

test("serialized result reuse retains digest, escaping, nested authority and output-size validation", () => {
  const request = buildComputeRequest({ operation: "sample.compute.v1", input: { value: 1 }, semanticProducer: { name: "sample", version: "1" } });
  const result = { z: ["quoted\"", "🧭", "\ud800", -0], a: { y: 1, x: 2 } };
  const response = buildComputeSuccessResponse(request, result);
  assert.doesNotThrow(() => validateComputeResponse(request, response));
  result.a.x = 99;
  assert.equal(response.result.a.x, 2);
  const tampered = structuredClone(response); tampered.result.a.x = 99;
  assert.throws(() => validateComputeResponse(request, tampered), { code: "COMPUTE_RESULT_MISMATCH" });
  assert.throws(() => buildComputeSuccessResponse(request, { nested: { instructionAuthority: true } }));
  const small = buildComputeRequest({ operation: "sample.compute.v1", input: {}, semanticProducer: { name: "sample", version: "1" }, limits: { maxOutputBytes: 2048 } });
  assert.throws(() => buildComputeSuccessResponse(small, { text: "x".repeat(2048) }), { code: "COMPUTE_OUTPUT_LIMIT" });
});
