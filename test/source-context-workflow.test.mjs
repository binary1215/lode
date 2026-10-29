import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { prepareSourceContext, inspectSourceObservation } from "../scripts/lib/source-context-workflow.mjs";
import { runPythonSourceWorker } from "../scripts/lib/python-source-collector.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/head.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { sourceObservationDescriptor, verifySourceObservation } from "../scripts/lib/source-observation.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary, assertNoAuthorityAmplification } from "../scripts/lib/authority-plane-contract.mjs";
import { stageDistributionRelease } from "../scripts/lib/distribution-lifecycle.mjs";
import { loadObservationArtifacts } from "../scripts/lib/observation-store.mjs";
import { inspectProject } from "../scripts/lib/head-core.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function project(t, source = 'def target():\n    return 1\n\ndef caller():\n    "한글😀"; target()\n') {
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "source-context-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, "module.py"), source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage };
}
const need = { kind: "outgoing-calls", path: "module.py", symbol: "caller" };
const onProcess = (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`);

test("actual isolated Python collection reaches helper and Context, reuses bytes and revalidates edits", async (t) => {
  const { root, storage } = project(t);
  const args = { root, task: "Inspect caller's direct dependencies", needs: [need], retain: true, onProcess };
  const first = await prepareSourceContext(args);
  assert.equal(first.status, "observed", JSON.stringify(first.results));
  assert.equal(first.results[0].includedInContext, true);
  assert.equal(first.context.capsule.observationEvidence.length, 1);
  assert.match(first.context.capsule.observationEvidence[0].payload.details, /target/);
  assert.deepEqual(first.context.capsule.evidenceGaps, []);
  assert.equal(first.context.capsule.semanticSufficiencyOwner, "Lode");
  const second = await prepareSourceContext(args);
  assert.equal(second.results[0].reused, true);
  assert.equal(second.results[0].observationId, first.results[0].observationId);
  const read = inspectSourceObservation({ root, bundleKey: first.results[0].bundleKey });
  assert.equal(read.status, "current-source-bytes");
  fs.appendFileSync(path.join(root, "module.py"), "\n# dirty change\n");
  const historical = inspectSourceObservation({ root, bundleKey: first.results[0].bundleKey });
  assert.equal(historical.sourceState, "stale");
  assert.equal(historical.currentContextEligible, false);
  assert.equal(historical.evidence.sources[0].digest, first.results[0].sourceDigest);
  (await assert.rejects(async () => (await compileContext({ root, task: "Inspect", includeRepositoryWorld: false,
    evidenceNeeds: [{ id: "old", kind: "observation", observationIds: [first.results[0].observationId] }] })), { code: "SOURCE_DRIFT" }));
  const third = await prepareSourceContext(args);
  assert.equal(third.results[0].reused, false);
  assert.notEqual(third.results[0].observationId, first.results[0].observationId);
});

test("CRLF, UTF8 bytes and non-BMP before a call preserve exact UTF16 occurrence", async (t) => {
  const { root, storage } = project(t, 'def target():\r\n    pass\r\ndef caller():\r\n    "한글😀"; target()\r\n');
  const result = await prepareSourceContext({ root, task: "Inspect", needs: [need], onProcess });
  assert.equal(result.status, "observed", JSON.stringify(result.results));
  const details = JSON.parse(result.context.capsule.observationEvidence[0].payload.details);
  assert.equal(details.pairs[0].range.start.character, '    "한글😀"; '.length);
});

test("dynamic and shadowed names stay unresolved, independent source need continues", async (t) => {
  const { root, storage } = project(t, 'def target():\n    pass\ndef caller(target):\n    target()\n    self.target()\n');
  const result = await prepareSourceContext({ root, task: "Inspect", needs: [need, { kind: "source", path: "module.py" }], onProcess });
  assert.equal(result.status, "partial");
  assert.equal(result.results[0].status, "unavailable");
  assert.equal(result.results[0].unresolved.length, 2);
  assert.equal(result.results[1].includedInContext, true);
  assert.equal(result.pendingNeeds.length, 1);
  assert.equal(result.userActionRequired, false);
});

test("CLI and typed MCP need no JSON/hash input and task-only keeps selection with HEAD", async (t) => {
  const { root, storage } = project(t);
  const result = await runCommand(["source-context", root, "--task", "Inspect", "--source", "module.py", "--symbol", "caller"], { onProcess });
  assert.equal(result.status, "observed");
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_source_context", arguments: { project_root: root, task: "Inspect", needs: [need] } } }, { onProcess });
  assert.equal(mcp.result.structuredContent.status, "observed", JSON.stringify(mcp));
  const selection = await prepareSourceContext({ root, task: "Inspect" });
  assert.equal(selection.userActionRequired, false);
  assert.equal(selection.status, "head-selection-needed");
});

test("isolated interpreter ignores project ast/sitecustomize and honors cancellation and deadlines", async (t) => {
  const { root, storage } = project(t);
  for (const name of ["ast.py", "sitecustomize.py"]) fs.writeFileSync(path.join(root, name), 'raise RuntimeError("PROJECT CODE EXECUTED")\n');
  const oldPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = root;
  try {
    const identity = await runPythonSourceWorker({ operation: "identity" }, { onProcess });
    assert.equal(identity.result.profile.isolated, true);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runPythonSourceWorker({ operation: "identity" }, { signal: controller.signal, onProcess }), { code: "SOURCE_CANCELLED" });
    await assert.rejects(runPythonSourceWorker({ operation: "identity" }, { timeoutMs: 1, onProcess }), { code: "SOURCE_TIMEOUT" });
  } finally { if (oldPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = oldPath; }
});

test("conditional, decorated, nested, alias and duplicate bindings never become arbitrary targets", async (t) => {
  const variants = [
    'if False:\n    def target(): pass\ndef caller(): target()\n',
    'def target(): pass\ntarget = other\ndef caller(): target()\n',
    '@decorate\ndef target(): pass\ndef caller(): target()\n',
    'def target(): pass\ndef target(): pass\ndef caller(): target()\n',
    'def target(): pass\nclass A:\n    def caller(self): target()\n',
    'def caller():\n    target()\n    def target(): pass\n',
  ];
  for (const source of variants) {
    const { root, storage } = project(t, source);
    const selection = { ...need, symbol: source.includes('class A:') ? 'A.caller' : 'caller' };
    const result = await prepareSourceContext({ root, task: "Inspect", needs: [selection], onProcess });
    assert.equal(result.results[0].status, "unavailable", JSON.stringify(result.results));
    assert.equal(result.context, null);
  }
});

test("source drift during actual collection excludes that need, not independent source", async (t) => {
  const { root, storage } = project(t);
  fs.writeFileSync(path.join(root, "independent.txt"), "Independent evidence\n");
  let closed = 0;
  const result = await prepareSourceContext({ root, task: "Inspect", needs: [need, { kind: "source", path: "independent.txt" }],
    onProcess(event) { onProcess(event); if (event.event === "closed" && ++closed === 2) fs.appendFileSync(path.join(root, "module.py"), "# drift\n"); } });
  assert.equal(result.results[0].code, "SOURCE_DRIFT");
  assert.equal(result.results[1].includedInContext, true);
  assert.equal(result.context.capsule.observationEvidence.length, 1);
});

test("BOM, malformed UTF8, unsupported language and byte limit are scoped unavailable", async (t) => {
  const { root, storage } = project(t);
  fs.writeFileSync(path.join(root, "bom.py"), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("def caller(): pass\n")]));
  fs.writeFileSync(path.join(root, "invalid.py"), Buffer.from([255, 254, 0]));
  fs.writeFileSync(path.join(root, "large.py"), Buffer.alloc(1_048_577, 32));
  fs.writeFileSync(path.join(root, "other.ts"), "export function caller() {}\n");
  const result = await prepareSourceContext({ root, task: "Inspect", needs: ["bom.py", "invalid.py", "large.py", "other.ts"].map(file => ({ ...need, path: file })), onProcess });
  assert.deepEqual(result.results.map(item => item.code), ["SOURCE_ENCODING_UNSUPPORTED", "SOURCE_ENCODING_UNSUPPORTED", "SOURCE_BYTE_LIMIT", "SOURCE_LANGUAGE_UNSUPPORTED"]);
});

test("retained failure preserves raw bytes and coalesces identical retry without authority writes", async (t) => {
  const { root, storage } = project(t, "def caller(value):\n    value()\n");
  const args = { root, task: "Inspect", needs: [need], retain: true, onProcess };
  const first = await prepareSourceContext(args);
  assert.equal(first.results[0].status, "unavailable");
  const key = first.results[0].failureKey;
  assert.match(key, /^[a-f0-9]{64}$/);
  const read = inspectSourceObservation({ root, failureKey: key });
  assert.equal(read.sourceState, "current-source-bytes");
  assert.ok(read.failure.response);
  assert.equal(read.failure.recoveryAuthority, false);
  const second = await prepareSourceContext(args);
  assert.equal(second.results[0].failureKey, key);
});

test("retained source tamper and ephemeral record substitution fail closed at Context", async (t) => {
  const { root, storage } = project(t);
  const result = await prepareSourceContext({ root, task: "Inspect", needs: [need], retain: true, onProcess });
  const file = path.join(root, relativeProjectArtifact(storage, "observations", "source-bundles"), `${result.results[0].bundleKey}.json`);
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  bundle.observation.payload.details = "forged relationship";
  assert.throws(() => verifySourceObservation(root, bundle.evidence.projectId, bundle));
  (await assert.rejects(async () => (await compileContext({ root, task: "Inspect", evidenceNeeds: [{ id: "exact", kind: "observation", observationIds: [bundle.observation.observationId] }], sourceObservations: [bundle], includeRepositoryWorld: false }))));
  fs.writeFileSync(file, JSON.stringify(bundle));
  assert.throws(() => inspectSourceObservation({ root, bundleKey: result.results[0].bundleKey }));
  assert.equal(sourceObservationDescriptor.recoveryAuthority, false);
});

test("active cancellation settles only after owned worker close", async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(runPythonSourceWorker({ operation: "identity" }, { signal: controller.signal,
    onProcess(event) { onProcess(event); events.push(event); if (event.event === "started") controller.abort(); } }), { code: "SOURCE_CANCELLED" });
  assert.equal(events.at(-1).event, "closed");
  assert.ok(events.find(event => event.event === "started").pid);
});

test("unconfigured Python does not block ordinary exact-source Context", async (t) => {
  const { root, storage } = project(t);
  const prior = process.env.HEAD_PYTHON;
  process.env.HEAD_PYTHON = path.join(root, "missing-python");
  try {
    const result = await prepareSourceContext({ root, task: "Inspect", needs: [need, { kind: "source", path: "module.py" }], onProcess });
    assert.equal(result.results[0].code, "PYTHON_NOT_CONFIGURED");
    assert.equal(result.results[1].includedInContext, true);
    assert.equal(result.userActionRequired, false);
  } finally { if (prior === undefined) delete process.env.HEAD_PYTHON; else process.env.HEAD_PYTHON = prior; }
});

async function stdioSource(root, mode, options = {}) {
  const command = [process.execPath, path.join(pluginRoot, "scripts/mcp-server.mjs")];
  onProcess({ event: "planned", command, parentPid: process.pid, cwd: pluginRoot, ports: [] });
  const child = spawn(command[0], command.slice(1), { cwd: pluginRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  onProcess({ event: "started", pid: child.pid, command, parentPid: process.pid, cwd: pluginRoot, ports: [] });
  let stdout = "", stderr = "", triggered = false, timer, forceTimer;
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", data => { stdout += data; if (stdout.includes('\n')) child.stdin.end(); });
    child.stderr.on("data", data => {
      stderr += data; process.stderr.write(data);
      if (!triggered && stderr.includes('"event":"started"')) {
        triggered = true;
        if (mode === "cancel") child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + '\n');
        if (mode === "disconnect") child.stdin.end();
      }
    });
    child.once("close", code => {
      clearTimeout(timer); clearTimeout(forceTimer);
      onProcess({ event: "closed", pid: child.pid, exitCode: code, ports: [] });
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
    });
    timer = setTimeout(() => { child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), 1000); }, 10_000);
  });
  child.stdin.on("error", () => {});
  const sourceArgs = { project_root: root, task: "Inspect", needs: [need], ...options };
  const params = mode === "normal" ? { name: "head_source_context", arguments: sourceArgs }
    : { name: "head_tools_call", arguments: { name: "head_source_context", arguments: sourceArgs } };
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) + '\n');
  return completion;
}

test("actual stdio MCP collects, handles request cancellation and connection loss", async (t) => {
  const { root, storage } = project(t);
  const normal = await stdioSource(root, "normal");
  assert.equal(normal.result.structuredContent.status, "observed");
  for (const mode of ["cancel", "disconnect"]) {
    const result = await stdioSource(root, mode);
    assert.equal(result.result.structuredContent.results[0].code, "SOURCE_CANCELLED", JSON.stringify(result));
  }
});

test("damaged, missing and malformed retained candidates preserve originals and recollect without losing independent needs", async (t) => {
  for (const corruption of ["truncated", "missing", "wrong-fields"]) {
    const { root, storage } = project(t);
    fs.writeFileSync(path.join(root, "independent.txt"), "Independent current source\n");
    const first = await prepareSourceContext({ root, task: "Inspect", needs: [need], retain: true, onProcess });
    const file = path.join(root, relativeProjectArtifact(storage, "observations", "source-bundles"), `${first.results[0].bundleKey}.json`);
    if (corruption === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, corruption === "truncated" ? '{"truncated":' : JSON.stringify({ evidence: { sources: false }, descriptor: {}, observation: {} }));
    const damaged = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    // A separate source request changes no semantics and must remain observable.
    const response = await stdioSource(root, "normal", { needs: [need, { kind: "source", path: "independent.txt" }], retain: true });
    const recovered = response.result.structuredContent;
    assert.equal(recovered.status, "observed", JSON.stringify(recovered));
    assert.ok(recovered.results.every(result => result.includedInContext));
    if (damaged !== null) {
      assert.equal(fs.readFileSync(file, "utf8"), damaged);
      assert.ok(recovered.results[0].storageIssues.some(issue => issue.status === "invalid"));
      assert.notEqual(recovered.results[0].bundleKey, first.results[0].bundleKey);
    }
  }
});

test("Unicode separators and form feed in a literal retain physical Python line coordinates", async (t) => {
  for (const separator of ["\u2028", "\u2029", "\f"]) {
    const prefix = `    "한글${separator}😀"; `;
    const { root, storage } = project(t, `def target(): pass\ndef caller():\n${prefix}target()\n`);
    const result = await prepareSourceContext({ root, task: "Inspect", needs: [need], onProcess });
    assert.equal(result.status, "observed", JSON.stringify(result.results));
    const details = JSON.parse(result.context.capsule.observationEvidence[0].payload.details);
    assert.deepEqual(details.pairs[0].range.start, { line: 2, character: prefix.length });
  }
});

test("modern Python mapping-rest binding cannot resolve to a same-name module function", async (t) => {
  const identity = await runPythonSourceWorker({ operation: "identity" }, { onProcess });
  const [major, minor] = identity.result.profile.python.split(/[. ]/).map(Number);
  if (major < 3 || major === 3 && minor < 10) { t.skip("Requires a real Python 3.10+ parser; separately execute with HEAD_PYTHON on a modern runtime."); return; }
  const { root, storage } = project(t, "def target(): pass\ndef caller(value):\n    match value:\n        case {**target}:\n            target()\n");
  const result = await prepareSourceContext({ root, task: "Inspect", needs: [need], onProcess });
  assert.equal(result.results[0].status, "unavailable");
  assert.notEqual(result.results[0].reason, "parse-unsupported");
  assert.equal(result.results[0].unresolved[0].reason, "local-shadowing-or-rebinding");
  assert.equal(result.context, null);
});

test("new artifact planes preserve P2 Capsule type and legacy boundary without amplification", () => {
  assert.equal(artifactAuthorityBoundary("SourceCollectionFailure").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("SourceContextResult").planeId, "P4");
  const legacy = { ...artifactAuthorityBoundary("ContextCapsule"), contractVersion: "0.6.0" };
  assert.equal(verifyArtifactAuthorityBoundary("ContextCapsule", legacy).planeId, "P2");
  assert.throws(() => assertNoAuthorityAmplification({ sourceKind: "SourceContextResult", targetKind: "SessionRunCheckpoint" }), { code: "RECOVERY_AUTHORITY_AMPLIFICATION_REJECTED" });
});

test("packaged Python is subject to existing development-context exclusion", (t) => {
  const { root: parent } = project(t);
  const candidate = path.join(parent, "plugin");
  fs.mkdirSync(path.join(candidate, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(candidate, "scripts"));
  fs.copyFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), path.join(candidate, ".codex-plugin/plugin.json"));
  fs.copyFileSync(path.join(pluginRoot, "package.json"), path.join(candidate, "package.json"));
  fs.copyFileSync(path.join(pluginRoot, "LICENSE"), path.join(candidate, "LICENSE"));
  fs.writeFileSync(path.join(candidate, "scripts/lode.mjs"), "export const example = true;\n");
  fs.writeFileSync(path.join(candidate, "scripts/head.mjs"), 'export * from "./lode.mjs";\n');
  fs.writeFileSync(path.join(candidate, "scripts/worker.py"), `# ${["ultimate", "goal"].join("_")}\n`);
  assert.throws(() => stageDistributionRelease({ sourceRoot: candidate, destinationRoot: path.join(parent, "release") }), { code: "HEAD_DISTRIBUTION_DEVELOPMENT_CONTEXT_LEAK" });
});

test("common by-source-key null, shape and reference corruption cannot gate independent fresh source needs", async (t) => {
  for (const damaged of ["null", "{}", "[]", '{"descriptorId":"missing-descriptor"}', '{"truncated":']) {
    const { root, storage } = project(t);
    for (const file of ["seed.txt", "independent.txt", "other.txt"]) fs.writeFileSync(path.join(root, file), "Current source evidence\n");
    await prepareSourceContext({ root, task: "Seed", needs: [{ kind: "source", path: "seed.txt" }], retain: true });
    const directory = path.join(root, relativeProjectArtifact(storage, "observations", "records", "by-source-key"));
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith(".json")));
    fs.writeFileSync(file, damaged);
    const inspected = inspectProject(root);
    assert.throws(() => loadObservationArtifacts({ projectRoot: root, projectId: inspected.project.projectId, storage }), error => ["INVALID_OBSERVATION_ARTIFACT", "UNKNOWN_OBSERVATION_DESCRIPTOR"].includes(error.code));
    const result = await prepareSourceContext({ root, task: "Inspect independent sources", needs: [{ kind: "source", path: "independent.txt" }, { kind: "source", path: "other.txt" }], retain: true });
    assert.equal(result.status, "observed", JSON.stringify(result));
    assert.ok(result.results.every(item => item.includedInContext));
    assert.ok(result.results.every(item => item.storageIssues.some(issue => issue.reference === "observation-index" && issue.status === "invalid")));
    assert.equal(fs.readFileSync(file, "utf8"), damaged);
  }
});
