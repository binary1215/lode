import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { prepareSourceContext, inspectSourceObservation } from "../scripts/lib/source-context-workflow.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { exactDeclarationSlice } from "../scripts/lib/python-source-collector.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const onProcess = (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`);
function project(t, source) {
  const root = fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "declarations-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "module.py"), source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage };
}
const need = (kind, symbol = "", selection) => ({ kind, path: "module.py", symbol, ...(selection ? { selection } : {}) });
const query = async (root, needs, options = {}) => (await prepareSourceContext({ root, task: "Inspect exact source", needs, onProcess, ...options }));
const details = (result) => JSON.parse(result.context.capsule.observationEvidence[0].payload.details);

test("known decorated async method preserves literal spaces, CRLF, tabs, Unicode and long header exactly", async (t) => {
  const header = `async def 읽기(self, value: str = "a  b", /, *, note: str = "${"x".repeat(600)}") -> str:`;
  const selected = `@decorate(\r\n\t\t"😀",\r\n\t)\r\n\t${header}\r\n\t\t# internal 한글\r\n\t\treturn "😀" + value`;
  const source = `# unrelated\r\nclass Reader:\r\n\t${selected}\r\n\t# trailing comment\r\n`;
  const { root, storage } = project(t, source);
  const before = fs.readFileSync(path.join(root, storage.directory, "sessions/current.json"));
  const result = await query(root, [need("selected-source", "Reader.읽기")], { retain: true });
  assert.equal(result.status, "observed", JSON.stringify(result.results));
  const d = details(result);
  assert.equal(d.source, selected);
  assert.equal(d.declarations[0].displaySignature.length, 500);
  assert.equal(d.declarations[0].displaySignatureTruncated, true);
  assert.equal(d.declarations[0].kind, "async-method");
  assert.equal(exactDeclarationSlice(source, d.declarations[0].headerRange).text, header);
  assert.deepEqual(fs.readFileSync(path.join(root, storage.directory, "sessions/current.json")), before);
  const read = inspectSourceObservation({ root, bundleKey: result.results[0].bundleKey });
  assert.equal(read.evidence.version, 2);
  assert.equal(read.observation.typeKey, "source.python-declaration-context");
  assert.equal(JSON.stringify(result).includes("base64"), false);
  assert.equal(JSON.stringify(result).includes("unrelated"), false);
});

test("optional outline exposes static occurrences; ambiguous names require exact current selection", async (t) => {
  const source = 'if enabled:\n    def f(): return "first"\nelse:\n    def f(): return "second"\nclass C:\n    def method(self):\n        def nested(): pass\n        return nested\n';
  const { root, storage } = project(t, source);
  const outline = await query(root, [need("declarations")]);
  assert.equal(outline.status, "observed", JSON.stringify(outline.results));
  const list = details(outline).declarations;
  assert.deepEqual(list.map((d) => d.qualifiedName), ["f", "f", "C", "C.method", "C.method.nested"]);
  assert.equal(list[0].conditional, true);
  const ambiguous = await query(root, [need("selected-source", "f")]);
  assert.equal(ambiguous.results[0].status, "ambiguous");
  assert.equal(ambiguous.context, null);
  const chosen = await query(root, [need("selected-source", "f", list[1].selection)]);
  assert.equal(details(chosen).source, 'def f(): return "second"');
  fs.appendFileSync(path.join(root, "module.py"), "# edit\n");
  const stale = await query(root, [need("selected-source", "f", list[1].selection), need("source")]);
  assert.equal(stale.results[0].status, "stale-selection");
  assert.equal(stale.results[1].includedInContext, true);
  assert.equal(stale.userActionRequired, false);
});

test("list and body bounds are explicit; parse failure and missing are not empty complete success", async (t) => {
  const { root, storage } = project(t, Array.from({ length: 65 }, (_, i) => `def f${i}(): pass\n`).join(""));
  const result = await query(root, [need("declarations")]);
  assert.equal(details(result).status, "partial");
  assert.equal(details(result).total, 65);
  assert.equal(details(result).omitted, 1);
  assert.equal(details(await query(root, [need("selected-source", "f64")])).source, "def f64(): pass");
  fs.writeFileSync(path.join(root, "module.py"), `def huge():\n    return "${"a".repeat(50000)}"\n`);
  assert.equal((await query(root, [need("selected-source", "huge")])).results[0].status, "source-too-large");
  fs.writeFileSync(path.join(root, "module.py"), "def broken(\n");
  assert.equal((await query(root, [need("declarations")])).results[0].status, "parse-unsupported");
  fs.writeFileSync(path.join(root, "module.py"), "# empty valid module\n");
  assert.equal(details(await query(root, [need("declarations")])).total, 0);
  assert.equal((await query(root, [need("selected-source", "absent")])).results[0].status, "missing");
});

test("retained declaration evidence revalidates at Context consumption and detects tamper", async (t) => {
  const { root, storage } = project(t, "def f(): return 1\n");
  const result = await query(root, [need("selected-source", "f")], { retain: true });
  const record = result.results[0];
  const args = { root, task: "Inspect", includeRepositoryWorld: false, evidenceNeeds: [{ id: "body", kind: "observation", observationIds: [record.observationId] }] };
  (await compileContext(args));
  fs.appendFileSync(path.join(root, "module.py"), "# changed\n");
  (await assert.rejects(async () => (await compileContext(args)), { code: "SOURCE_DRIFT" }));
  assert.equal(inspectSourceObservation({ root, bundleKey: record.bundleKey }).sourceState, "stale");
  const file = path.join(root, storage.directory, "observations/source-bundles", `${record.bundleKey}.json`);
  const bundle = JSON.parse(fs.readFileSync(file)); bundle.evidence.query[0].symbol = "other";
  fs.writeFileSync(file, JSON.stringify(bundle));
  assert.throws(() => inspectSourceObservation({ root, bundleKey: record.bundleKey }), { code: "SOURCE_OBSERVATION_INVALID" });
});

test("collection drift fails only affected need; parser unavailable leaves source usable", async (t) => {
  const { root, storage } = project(t, "def f(): pass\n");
  let count = 0;
  const result = await query(root, [need("selected-source", "f")], { onProcess(event) {
    onProcess(event);
    if (event.event === "closed" && ++count === 2) fs.appendFileSync(path.join(root, "module.py"), "# drift\n");
  } });
  assert.equal(result.results[0].code, "SOURCE_DRIFT");
  const previous = process.env.HEAD_PYTHON;
  process.env.HEAD_PYTHON = path.join(root, "missing-python");
  try {
    const absent = await query(root, [need("declarations"), need("source")]);
    assert.equal(absent.results[0].code, "PYTHON_NOT_CONFIGURED");
    assert.equal(absent.results[1].includedInContext, true);
  } finally { if (previous === undefined) delete process.env.HEAD_PYTHON; else process.env.HEAD_PYTHON = previous; }
});

test("CLI explicit kind and typed MCP match without changing legacy --symbol", async (t) => {
  const { root, storage } = project(t, "def f(): pass\ndef g(): f()\n");
  const result = await runCommand(["source-context", root, "--task", "Inspect", "--source", "module.py", "--kind", "selected-source", "--symbol", "f"], { onProcess });
  assert.equal(details(result).source, "def f(): pass");
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_source_context", arguments: { project_root: root, task: "Inspect", needs: [need("selected-source", "f")] } } }, { onProcess });
  assert.equal(details(mcp.result.structuredContent).source, "def f(): pass");
  const legacy = await runCommand(["source-context", root, "--task", "Inspect", "--source", "module.py", "--symbol", "g"], { onProcess });
  assert.equal(legacy.results[0].need.kind, "outgoing-calls");
});

test("parenthesized decorators, overloads, tab header and reordered selection keys remain usable", async (t) => {
  const source = '@(\n    decorate\n)\n@other("a  b")\ndef\tf(value: str = "😀", /, *, flag=True): return value\n@overload\ndef dup(x: str): ...\n@overload\ndef dup(x: int): ...\n';
  const { root, storage } = project(t, source);
  const outlineResult = await query(root, [need("declarations")]);
  assert.equal(outlineResult.status, "observed", JSON.stringify(outlineResult.results));
  const outline = details(outlineResult);
  const first = outline.declarations[0];
  const reordered = Object.fromEntries(Object.entries(first.selection).reverse());
  reordered.range = { end: first.range.end, start: first.range.start };
  const chosen = await query(root, [need("selected-source", "f", reordered)]);
  assert.equal(details(chosen).source, source.slice(0, source.indexOf("\n@overload")));
  assert.equal((await query(root, [need("selected-source", "dup")])).results[0].status, "ambiguous");
  assert.throws(() => exactDeclarationSlice('"😀"', { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }), { code: "SOURCE_RESPONSE_INVALID" });
});

test("ephemeral declaration success and failures expose compact parser provenance without raw evidence", async (t) => {
  const { root, storage } = project(t, '# DO_NOT_PUBLISH_FULL_FILE\ndef f(): pass\n');
  const assertProfile = (profile) => {
    assert.equal(profile.producer, "python-stdlib-ast");
    assert.equal(profile.declarationProtocol, "python-static-declarations-1");
    assert.match(profile.pythonVersion, /^3\./u);
    assert.match(profile.profileDigest, /^[a-f0-9]{64}$/u);
    assert.match(profile.workerDigest, /^[a-f0-9]{64}$/u);
    assert.match(profile.normalizerDigest, /^[a-f0-9]{64}$/u);
    assert.equal(profile.isolated, true);
    assert.equal(profile.noSite, true);
    assert.ok(Buffer.byteLength(JSON.stringify(profile)) < 800);
  };
  for (const kind of ["declarations", "selected-source"]) {
    const result = await query(root, [need(kind, kind === "selected-source" ? "f" : "")]);
    assertProfile(details(result).collectionProfile);
    assert.equal(result.results[0].retained, false);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PUBLISH_FULL_FILE|"base64"|"response"|"executableDigest"/u);
  }
  fs.writeFileSync(path.join(root, "module.py"), 'def broken(\n# PRIVATE_PARSE_INPUT\n');
  const failed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "head_source_context", arguments: {
    project_root: root, task: "Inspect", needs: [need("declarations")],
  } } }, { onProcess });
  const failure = failed.result.structuredContent;
  assert.equal(failure.results[0].status, "parse-unsupported");
  assertProfile(failure.results[0].collectionProfile);
  assert.equal(failure.results[0].retained, false);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PARSE_INPUT|"base64"|"executableDigest"/u);
  fs.writeFileSync(path.join(root, "module.py"), "def f(): pass\n");
  const controller = new AbortController(); let closes = 0;
  const cancelled = await query(root, [need("declarations")], { signal: controller.signal, onProcess(event) {
    onProcess(event); if (event.event === "closed" && ++closes === 1) controller.abort();
  } });
  assert.equal(cancelled.results[0].code, "SOURCE_CANCELLED");
  assertProfile(cancelled.results[0].collectionProfile);
  assert.equal(fs.existsSync(path.join(root, storage.directory, "observations/source-bundles")), false);
});

test("return lambdas and explicit async line joins preserve the complete exact header", async (t) => {
  for (const header of [
    'def target() -> lambda x: x:',
    'def target() -> lambda x: lambda y: (x, y):',
    'def target(value=lambda x: x):',
    'async \\\ndef target():',
    'async \\\r\ndef target():',
  ]) {
    const source = `${header}\n    return 1\n`;
    const { root, storage } = project(t, source);
    const result = await query(root, [need("selected-source", "target")]);
    assert.equal(result.status, "observed", JSON.stringify(result.results));
    const d = details(result);
    assert.equal(d.source, `${header}\n    return 1`);
    assert.equal(exactDeclarationSlice(source, d.declarations[0].headerRange).text, header);
    assert.equal(d.declarations[0].displaySignature, header.replace(/\s+/gu, " "));
  }
});
