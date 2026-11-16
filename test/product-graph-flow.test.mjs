import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { productGraphWalk as walk } from "../scripts/graph-explorer/product-graph-walk.js";
import { buildProductGraph, checkProductGraph, readProductGraphBuild, moveProductGraphBaseline } from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import {
  addContentHashes,
  baselineFromGraph,
  compareWithBaseline,
  productGraphReader,
  readRetainedContent,
  retainedContentFor,
  serializeBaseline,
  sourceTextHash,
} from "../scripts/lib/world/product-graph-compare.mjs";
import { exportGraphExplorer } from "../scripts/lib/world/graph-explorer.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { fixture as coreFixture, snapshot as coreSnapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const put = (root, name, text) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-graph-flow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"),
    documentsDirectory = path.join(root, "documents"),
    rulesFile = path.join(root, "rules.json"),
    outputDirectory = path.join(root, "build");
  fs.mkdirSync(documentsDirectory);
  put(sourceRoot, "package.json", '{"bin":{"notes":"bin.mjs"}}\n');
  put(sourceRoot, "bin.mjs", 'import { saveNote } from "./notes.mjs";\nsaveNote();\n');
  put(sourceRoot, "notes.mjs", "export function saveNote() { return store(); }\nfunction store() { return 1; }\n");
  put(root, "rules.json", '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[]}\n');
  return { root, sourceRoot, documentsDirectory, rulesFile, outputDirectory };
}
// A Project whose source carries one distinctive line, to look for in what leaves the machine.
function projectWithMarker(t, marker) {
  const f = coreFixture(t);
  put(f.root, "package.json", '{"bin":{"notes":"bin.mjs"}}\n');
  put(f.root, "bin.mjs", 'import { saveNote } from "./notes.mjs";\nsaveNote();\n');
  put(f.root, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() {\n  const marker = "${marker}";\n  return marker;\n}\n`);
  return { ...f, build: path.join(f.root, ".lode/context/product-graph/build") };
}

test("full-text search preserves exact IDs/paths, Korean inflection and real edges without semantic promotion", () => {
  const nodes = [
    { id: "UA-01", type: "유저 활동", oneLine: "메모 저장 오류를 확인한다", basis: { status: "추정" } },
    { id: "P1", type: "정책", 조건: "메모가 비었다", 주체: "사용자", 행위: "저장을 막는다" },
    { id: "cli:saveNote", type: "기능", oneLine: "메모 저장", positions: [] },
    { id: "notes.mjs#saveNote", type: "코드", file: "notes.mjs", name: "saveNote" },
    { id: "unrelated", type: "기능", oneLine: "사진 저장", positions: [] },
  ];
  const edges = [
    { type: "정책→기능", from: "P1", to: "cli:saveNote" },
    { type: "기능→코드", from: "cli:saveNote", to: "notes.mjs#saveNote" },
    { type: "call", from: "notes.mjs#saveNote", to: "missing" },
  ];
  const ctx = walk.context({ graph: { nodes, edges } });
  assert.equal(walk.find(ctx, "cli:saveNote")[0].id, "cli:saveNote");
  assert.equal(walk.find(ctx, "notes.mjs")[0].id, "notes.mjs#saveNote");
  const hits = walk.search(ctx, "메모를 저장할 때");
  assert(hits.findIndex((hit) => hit.node.id === "cli:saveNote") < hits.findIndex((hit) => hit.node.id === "unrelated"));
  assert.equal(walk.search(ctx, "saveNote")[0].matchedTerms.includes("save"), true);
  assert.equal(walk.search(ctx, "메모".normalize("NFD")).length > 0, true);
  // Connections are recorded edges only, and come with the shown page.
  const shown = walk.ask(ctx, { question: "find", text: "메모를 저장할 때", limit: 50 }).search.results;
  for (const hit of shown) for (const edge of hit.connections) assert(edges.some((original) => JSON.stringify(original) === JSON.stringify(edge)));
  assert(shown.find((hit) => hit.id === "UA-01").basis.status === "추정");
  const saveHit = walk.ask(ctx, { question: "find", text: "saveNote", limit: 50 }).search.results.find((hit) => hit.id === "notes.mjs#saveNote");
  assert(!saveHit.connections.some((edge) => edge.to === "missing"));
  assert.match(walk.ask(ctx, { question: "find", text: "메모", limit: 1 }).text, /승인·현재성·인과가 아니다/);
  const filtered = walk.ask(ctx, { question: "find", text: "저장", nodeTypes: ["기능"], relatedTo: "P1", edgeTypes: ["정책→기능"], limit: 1 });
  assert.equal(filtered.search.results[0].id, "cli:saveNote");
  assert.equal(filtered.page.total, 1);
  assert.equal(walk.search(ctx, "메모", { basisStates: ["추정"] })[0].node.id, "UA-01");
});

test("M5: the shared walk keeps no state between graphs; an answer does not depend on what was asked before", () => {
  const graph = (word) => ({
    nodes: [
      { id: "a", type: "기능", oneLine: `메모 ${word}` },
      { id: "b", type: "기능", oneLine: "사진 저장" },
    ],
    edges: [],
  });
  const ask = (g) => JSON.stringify(walk.ask(walk.context({ graph: g }), { question: "find", text: "저장" }));
  const alone = ask(graph("저장"));
  ask(graph("삭제"));
  ask(graph("저장 저장 저장"));
  assert.equal(ask(graph("저장")), alone);
  assert.equal(walk.ask(walk.context({ graph: graph("저장") }), { question: "find", text: "저장" }).search.indexing.tokenizedNodes, 2);
});

test("T1/T2: no product source text in check.json, check.txt, the build and check replies or a Graph Explorer export; only `changes --list content` shows it", async (t) => {
  const f = projectWithMarker(t, "MARKER-LINE-41");
  buildProductGraph({ root: f.root });
  put(f.root, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() {\n  const marker = "MARKER-LINE-42";\n  return marker;\n}\n`);
  const built = buildProductGraph({ root: f.root });
  const checked = checkProductGraph({ root: f.root });
  const local = path.join(f.base, "local.html"),
    shared = path.join(f.base, "shared.html");
  await exportGraphExplorer({ root: f.root, output: local });
  await exportGraphExplorer({ root: f.root, output: shared, share: true });
  const cliBuild = await runCommand(["product-graph-build", f.root]);
  const mcpCheck = await dispatch({
    jsonrpc: "2.0",
    id: "check",
    method: "tools/call",
    params: { name: "lode_tools_call", arguments: { name: "lode_product_graph_check", arguments: { project_root: f.root } } },
  });
  const outward = {
    "check.json": fs.readFileSync(path.join(f.build, "check.json"), "utf8"),
    "check.txt": fs.readFileSync(path.join(f.build, "check.txt"), "utf8"),
    "graph.json": fs.readFileSync(path.join(f.build, "graph.json"), "utf8"),
    "build reply": JSON.stringify(built),
    "check reply": JSON.stringify(checked),
    "CLI build reply": JSON.stringify(cliBuild),
    "MCP check reply": JSON.stringify(mcpCheck),
    "local export": fs.readFileSync(local, "utf8"),
    "shared export": fs.readFileSync(shared, "utf8"),
  };
  for (const [name, text] of Object.entries(outward)) assert(!/MARKER-LINE-4[12]/.test(text), name + " carries source text");
  // The comparison says that content changed, for which nodes, and how to ask.
  assert(built.changes.contentChanges.some((item) => item.id === "notes.mjs#store" && item.beforeRetained === true));
  assert.equal(built.changes.content.question, "changes --list content");
  assert.match(built.text, /changes --list content/);
  // The explicit question shows it, before and after.
  const answer = queryProductGraph({ root: f.root, question: "changes", list: "content" });
  assert.equal(answer.status, "answered");
  assert.match(answer.text, /MARKER-LINE-41/);
  assert.match(answer.text, /MARKER-LINE-42/);
  const detail = answer.rows.find((row) => row.detail?.id === "notes.mjs#store").detail;
  assert.equal(detail.before.status, "available");
  assert.equal(detail.after.status, "available");
  // The retained file is local and git-ignored by the build folder's own ignore file.
  assert.equal(fs.readFileSync(path.join(f.build, ".gitignore"), "utf8").includes("*"), true);
  assert(fs.existsSync(path.join(f.build, "baseline-content.json")));
});

test("T2: content answers are paged and bounded, and say what the bound left out; a printed next-page hint repeats the question", (t) => {
  const f = fixture(t);
  const long = "x".repeat(20 * 1024);
  put(f.sourceRoot, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() { return "${long}"; }\nfunction other() { return 1; }\n`);
  buildProductGraph(f);
  put(f.sourceRoot, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() { return "${long}y"; }\nfunction other() { return 2; }\n`);
  buildProductGraph(f);
  const first = queryProductGraph({ ...f, question: "changes", list: "content", limit: 1 });
  assert.equal(first.status, "answered");
  assert.ok(first.page.remaining > 0);
  const more = first.rows.find((row) => row.kind === "more");
  assert.match(more.text, /changes --list content --cursor 1 .*--limit 1 .*--expected-basis-sha256 [a-f0-9]{64}/);
  const store = queryProductGraph({ ...f, question: "changes", list: "content", limit: 50 }).rows.find((row) => row.detail?.id === "notes.mjs#store").detail;
  for (const side of [store.before, store.after]) {
    assert.equal(side.status, "partial");
    assert.ok(side.omittedBytes > 0);
    assert.ok(Buffer.byteLength(side.text) <= 16 * 1024);
  }
  // Following the structured next arguments gives the next item once.
  const second = queryProductGraph({ ...f, ...first.page.nextArguments });
  assert.equal(second.status, "answered");
  assert.notEqual(second.rows[0].detail?.id, first.rows[0].detail?.id);
});

test("T4: the retained budget is shared fairly; Korean-ID documents and file nodes keep their text; no entry for what is not retained", () => {
  const big = "y".repeat(4000);
  const text = Array.from({ length: 30 }, (_, n) => `function f${n}() { return "${big}${n}"; }`).join("\n") + "\n";
  const graph = {
    inputs: { reader: productGraphReader(1), sourceFiles: [{ path: "x.mjs", sha256: sourceTextHash(text) }], documents: [], rulesSha256: null },
    nodes: [
      { id: "x.mjs", type: "코드", kind: "file", file: "x.mjs" },
      ...Array.from({ length: 30 }, (_, n) => ({ id: `x.mjs#f${n}`, type: "코드", kind: "function", file: "x.mjs", lines: [n + 1, n + 1] })),
      { id: "화면-가", type: "화면", oneLine: "메모 목록", name: "목록" },
      { id: "UA-가-01", type: "유저 활동", oneLine: "메모를 저장한다" },
    ],
    edges: [],
  };
  addContentHashes(graph, new Map([["x.mjs", text]]));
  const budget = { totalBytes: 40 * 1024, entryBytes: 16 * 1024 };
  const document = retainedContentFor({ graph, baselineBytes: Buffer.from("b"), readText: () => text, budget });
  assert.equal(document.entries["화면-가"].complete, true);
  assert.equal(document.entries["UA-가-01"].complete, true);
  assert.ok(document.entries["x.mjs"], "the file node keeps a part of its text");
  assert.ok(document.counts.bytes <= budget.totalBytes);
  for (const entry of Object.values(document.entries)) assert.ok(entry.text.length > 0);
  // Every entry has text; nodes with nothing retained have no entry.
  assert.equal(Object.keys(document.entries).length, document.counts.complete + document.counts.partial);
  assert.equal(document.counts.notRetained, graph.nodes.length - document.counts.complete - document.counts.partial);
});

test("T5: a line shift above an entry point does not list its 기능 as changed content", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  put(f.sourceRoot, "bin.mjs", '// a comment line above\nimport { saveNote } from "./notes.mjs";\nsaveNote();\n');
  const built = buildProductGraph(f);
  const listed = built.changes.contentChanges.map((item) => item.id);
  const functions = readProductGraphBuild(f)
    .graph.nodes.filter((node) => node.type === "기능")
    .map((node) => node.id);
  assert.ok(functions.length > 0);
  for (const id of functions) assert(!listed.includes(id), id + " is listed after a line shift");
});

test("T6/M2: retained content is bound to the baseline's bytes and the way code is read; a hand-edited entry is rejected; an update that reads code the same way keeps it", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const contentFile = path.join(f.outputDirectory, "baseline-content.json"),
    baselineFile = path.join(f.outputDirectory, "baseline.json");
  const baseline = json(baselineFile),
    baselineBytes = fs.readFileSync(baselineFile);
  const document = json(contentFile);
  assert.equal(readRetainedContent(contentFile, { baseline, baselineBytes }).status, "read");
  // A stated-fields entry edited by hand no longer hashes to the baseline's content.
  const stated = Object.entries(document.entries).find(([, entry]) => entry.format === "stated-fields");
  assert.ok(stated, "a stated-fields entry exists");
  const edited = structuredClone(document);
  edited.entries[stated[0]].text = edited.entries[stated[0]].text.replace(/"kind": "[^"]+"/, '"kind": "edited"');
  fs.writeFileSync(contentFile, JSON.stringify(edited));
  const read = readRetainedContent(contentFile, { baseline, baselineBytes });
  assert.equal(read.entries.has(stated[0]), false);
  assert.ok(read.rejected >= 1);
  fs.writeFileSync(contentFile, JSON.stringify(document));
  // Another Lode version that reads code the same way (only reader.lode differs).
  const updated = structuredClone(baseline);
  updated.reader = { ...updated.reader, lode: "9.9.9" };
  const relabelled = structuredClone(document);
  assert.equal(readRetainedContent(contentFile, { baseline: updated, baselineBytes }).status, "read");
  // A different way of reading code does not reuse it.
  updated.reader = { ...updated.reader, sourceAnalysis: "other" };
  assert.equal(readRetainedContent(contentFile, { baseline: updated, baselineBytes }).status, "other-reader");
  void relabelled;
  // Another baseline's bytes do not reuse it.
  assert.equal(
    readRetainedContent(contentFile, { baseline, baselineBytes: Buffer.from(serializeBaseline({ ...baseline, setAt: "other" })) }).status,
    "other-baseline",
  );
});

test("M2: a baseline without retained content gets it once, only for nodes whose content is still the baseline's", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const contentFile = path.join(f.outputDirectory, "baseline-content.json");
  fs.rmSync(contentFile);
  put(f.sourceRoot, "notes.mjs", "export function saveNote() { return store(); }\nfunction store() { return 2; }\n");
  const built = buildProductGraph(f);
  const document = json(contentFile);
  assert.equal(document.entries["notes.mjs#store"], undefined, "changed since the baseline: no before");
  assert.ok(document.entries["notes.mjs#saveNote"], "unchanged: before is the same text");
  assert.equal(built.changes.contentChanges.find((item) => item.id === "notes.mjs#store").beforeRetained, false);
  // Written once: a later build leaves it as it is.
  const bytes = fs.readFileSync(contentFile);
  buildProductGraph(f);
  assert.deepEqual(fs.readFileSync(contentFile), bytes);
  // The baseline move rewrites both.
  moveProductGraphBaseline(f);
  assert.ok(json(contentFile).entries["notes.mjs#store"]);
});

test("M3/M4: a printed hint carries the filters and builds; a later page refuses a changed basis; an unknown anchor or an unreadable build is said", (t) => {
  const f = fixture(t);
  put(f.sourceRoot, "more.mjs", Array.from({ length: 6 }, (_, n) => `export function noteHelper${n}() { return ${n}; }`).join("\n") + "\n");
  buildProductGraph(f);
  const first = queryProductGraph({ ...f, question: "find", text: "note", nodeTypes: ["코드"], limit: 2 });
  assert.equal(first.status, "answered");
  const more = first.rows.find((row) => row.kind === "more");
  assert.match(more.text, /--node-types 코드/);
  assert.match(more.text, /--limit 2/);
  assert.match(more.text, new RegExp(`--expected-basis-sha256 ${first.basisSha256}`));
  const second = queryProductGraph({ ...f, ...first.page.nextArguments });
  assert.equal(second.status, "answered");
  assert.equal(second.basisSha256, first.basisSha256);
  // The build changes: the next page refuses rather than mixing.
  put(f.sourceRoot, "more.mjs", "export function noteHelper0() { return 9; }\n");
  buildProductGraph(f);
  const stale = queryProductGraph({ ...f, ...first.page.nextArguments });
  assert.equal(stale.status, "basis-changed");
  assert.equal(stale.code, "PRODUCT_GRAPH_QUERY_BASIS_CHANGED");
  // An anchor that is not in the graph.
  const unknown = queryProductGraph({ ...f, question: "find", text: "note", relatedTo: "no-such-node" });
  assert.equal(unknown.status, "refused");
  assert.equal(unknown.code, "PRODUCT_GRAPH_NODE_NOT_FOUND");
  assert.match(unknown.text, /no-such-node/);
  // A candidate build folder that cannot be read is not "not given".
  const broken = path.join(f.root, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "graph.json"), "{");
  const unreadable = queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: broken });
  assert.equal(unreadable.status, "refused");
  assert.equal(unreadable.code, "PRODUCT_GRAPH_BUILD_UNREADABLE");
  assert.match(unreadable.text, /제안 빌드/);
  const missingBase = queryProductGraph({
    ...f,
    question: "impact",
    candidateBuildDirectory: f.outputDirectory,
    proposalBaseBuildDirectory: path.join(f.root, "missing"),
  });
  assert.equal(missingBase.status, "refused");
  assert.match(missingBase.text, /제안 출발 빌드/);
});

test("read-only check/query do not change sources, baseline, retained content or candidate; CLI and common walk agree", async (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const files = ["graph.json", "check.json", "check.txt", "baseline.json", "baseline-content.json", "build-context.json"];
  const before = files.map((name) => fs.readFileSync(path.join(f.outputDirectory, name), "utf8"));
  checkProductGraph(f);
  const result = queryProductGraph({ ...f, question: "find", text: "saveNote" });
  queryProductGraph({ ...f, question: "changes", list: "content" });
  const read = readProductGraphBuild(f);
  const shared = walk.ask(walk.context(read), { question: "find", text: "saveNote" });
  assert.equal(result.text, shared.text);
  const cli = await runCommand([
    "product-graph-query",
    f.sourceRoot,
    "find",
    "saveNote",
    "--build",
    f.outputDirectory,
    "--documents",
    f.documentsDirectory,
    "--rules",
    f.rulesFile,
  ]);
  assert.equal(cli.text, result.text);
  files.forEach((name, i) => assert.equal(fs.readFileSync(path.join(f.outputDirectory, name), "utf8"), before[i]));
});

test("three-way impact distinguishes equal edits, concurrent policy changes, deleted UI references and missing/partial bases", () => {
  const base = {
    kind: "LodeProductGraph",
    nodes: [
      { id: "P1", type: "정책", 행위: "막는다", contentSha256: "old" },
      { id: "UI1", type: "화면요소", contentSha256: "ui" },
      { id: "UA1", type: "유저 활동", contentSha256: "ua" },
    ],
    edges: [{ type: "유저 활동→화면요소", from: "UA1", to: "UI1" }],
  };
  const current = structuredClone(base),
    candidate = structuredClone(base);
  current.nodes[0].행위 = candidate.nodes[0].행위 = "알린다";
  current.nodes[0].contentSha256 = candidate.nodes[0].contentSha256 = "same";
  const ctx = walk.context({ graph: current });
  const equal = walk.impact(ctx, { proposalBase: base, candidate, compatibility: { status: "verified" } });
  assert.equal(equal.conflicts.length, 0);
  assert.equal(equal.productApproved, false);
  candidate.nodes[0].행위 = "보낸다";
  candidate.nodes[0].contentSha256 = "different";
  candidate.nodes = candidate.nodes.filter((node) => node.id !== "UI1");
  const conflict = walk.impact(ctx, { proposalBase: base, candidate, compatibility: { status: "verified" } });
  assert(conflict.conflicts.some((item) => item.kind === "concurrent-policy-change"));
  assert(conflict.remainingReferences.some((edge) => edge.missing.includes("UI1")));
  assert.equal(walk.impact(ctx, { candidate }).status, "unavailable");
  assert.equal(walk.impact(ctx, { proposalBase: base, candidate }).structuralConflictFree, null);
});

test("impact query uses existing builds only and never claims scope compatibility for unrelated roots", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const base = path.join(f.root, "base"),
    candidate = path.join(f.root, "candidate");
  fs.cpSync(f.outputDirectory, base, { recursive: true });
  put(f.sourceRoot, "notes.mjs", "export function saveNote() { return 9; }\n");
  buildProductGraph({ ...f, outputDirectory: candidate });
  const result = queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate, proposalBaseBuildDirectory: base });
  assert.equal(result.impact.productApproved, false);
  assert.equal(result.impact.compatibility.status, "verified");
  const pinned = result.basisSha256;
  put(f.sourceRoot, "notes.mjs", "export function saveNote() { return 8; }\n");
  buildProductGraph({ ...f, outputDirectory: candidate });
  assert.equal(
    queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate, proposalBaseBuildDirectory: base, expectedBasisSha256: pinned }).status,
    "basis-changed",
  );
  const hashesOnly = queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate });
  assert.equal(hashesOnly.impact.structuralConflictFree, null);
  const metadataFile = path.join(candidate, "build-context.json"),
    metadata = json(metadataFile);
  metadata.scope.sourceRootHash = "unrelated";
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  const unrelated = queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate, proposalBaseBuildDirectory: base });
  assert.equal(unrelated.impact.compatibility.status, "partial");
  assert(unrelated.impact.compatibility.reasons.some((reason) => reason.includes("소스 루트")));
  // A build context that names no plugin-implementation hash: a plugin update that reads code the same way changes nothing here.
  assert.deepEqual(Object.keys(json(path.join(f.outputDirectory, "build-context.json")).scope).sort(), ["projectId", "reader", "sourceRootHash"]);
});

test("M7/actual CLI and routed typed MCP: a Project build copied aside before the proposal compares as verified, without changing Canon, P2 or source files", async (t) => {
  const f = coreFixture(t),
    synthetic = fixture(t);
  fs.cpSync(synthetic.sourceRoot, f.root, { recursive: true });
  buildProductGraph({ root: f.root });
  const current = path.join(f.root, ".lode/context/product-graph/build"),
    base = path.join(f.base, "starting"),
    proposed = path.join(f.base, "proposed");
  fs.cpSync(current, base, { recursive: true });
  put(f.root, "notes.mjs", "export function saveNote() { return 9; }\n");
  buildProductGraph({ root: f.root });
  fs.cpSync(current, proposed, { recursive: true });
  const before = coreSnapshot(f.root);
  const cli = await runCommand(["product-graph-query", f.root, "impact", "--proposal-base-build", base, "--candidate-build", proposed]);
  const mcp = await dispatch({
    jsonrpc: "2.0",
    id: "impact",
    method: "tools/call",
    params: {
      name: "lode_tools_call",
      arguments: {
        name: "lode_product_graph_query",
        arguments: { project_root: f.root, question: "impact", proposal_base_build: base, candidate_build: proposed },
      },
    },
  });
  assert.equal(mcp.error, undefined);
  const presented = mcp.result.content[0].text;
  assert(presented.startsWith(cli.text));
  const structured = mcp.result.structuredContent || JSON.parse(presented.split("구조화된 결과:\n")[1]);
  assert.deepEqual(structured.impact, cli.impact);
  assert.deepEqual(structured.rows, cli.rows);
  assert.equal(structured.basisSha256, cli.basisSha256);
  assert.equal(cli.impact.productApproved, false);
  assert.equal(cli.impact.compatibility.status, "verified", JSON.stringify(cli.impact.compatibility));
  assert.deepEqual(coreSnapshot(f.root), before);
  // A stand-alone --out candidate of the same source next to a Project build is partial, and says why.
  const standalone = path.join(f.base, "standalone");
  const rules = path.join(f.base, "rules.json");
  fs.writeFileSync(rules, '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[]}\n');
  fs.mkdirSync(path.join(f.base, "documents"));
  buildProductGraph({ sourceRoot: f.root, documentsDirectory: path.join(f.base, "documents"), rulesFile: rules, outputDirectory: standalone });
  const mixed = await runCommand(["product-graph-query", f.root, "impact", "--proposal-base-build", base, "--candidate-build", standalone]);
  assert.equal(mixed.impact.compatibility.status, "partial");
  assert(mixed.impact.compatibility.reasons.some((reason) => reason.includes("Project")));
});

test("R4: counted edge state, provenance divergence and delete/update conflict; real parallel citations retain identity or remain partial", () => {
  const graph = (count, basis = null) => ({
    kind: "LodeProductGraph",
    nodes: [
      { id: "a", type: "코드" },
      { id: "b", type: "코드" },
    ],
    edges: [{ type: "call", from: "a", to: "b", count, ...(basis ? { basis } : {}) }],
  });
  const preview = (base, current, candidate) =>
    walk.impact(walk.context({ graph: current }), { proposalBase: base, candidate, compatibility: { status: "verified" } });
  const divergent = preview(graph(1), graph(2), graph(3));
  assert(divergent.conflicts.some((item) => item.kind === "divergent-edge-change"));
  assert.equal(divergent.structuralConflictFree, false);
  assert.equal(preview(graph(1), graph(2), graph(2)).structuralConflictFree, true);
  assert(
    preview(graph(1, { status: "승인" }), graph(1, { status: "승인 뒤 바뀜" }), graph(1, { status: "추정" })).conflicts.some(
      (item) => item.kind === "divergent-edge-change",
    ),
  );
  const deleted = graph(1);
  deleted.edges = [];
  assert(preview(graph(1), graph(2), deleted).conflicts.some((item) => item.kind === "edge-delete-versus-update"));
  const parallel = graph(1);
  parallel.edges.push({ ...parallel.edges[0] });
  assert.equal(preview(parallel, parallel, parallel).structuralConflictFree, null);
  const distinct = structuredClone(parallel);
  distinct.edges.forEach((edge, i) => {
    edge.at = { path: "doc.md", line: i + 1 };
  });
  const current = structuredClone(distinct),
    proposed = structuredClone(distinct);
  current.edges[0].count = 2;
  proposed.edges[1].count = 3;
  const independent = preview(distinct, current, proposed);
  assert.equal(independent.conflicts.length, 0);
  assert.equal(independent.ambiguousRelations.length, 0);
});

test("R5: a baseline brought from another folder never supplies a 'before' from this folder's retained content; the structural comparison continues", (t) => {
  const a = fixture(t),
    b = fixture(t);
  buildProductGraph(a);
  const aBase = fs.readFileSync(path.join(a.outputDirectory, "baseline.json"));
  put(b.sourceRoot, "notes.mjs", "export function saveNote() { return 'project-B-current'; }\n");
  buildProductGraph(b);
  fs.writeFileSync(path.join(b.outputDirectory, "baseline.json"), aBase);
  const result = buildProductGraph(b);
  assert.equal(result.changes.status, "compared", "hash-only structural comparison remains available");
  assert.equal(result.changes.content.retainedFile.status, "other-baseline");
  assert(result.changes.contentChanges.every((change) => change.beforeRetained === false));
  assert.deepEqual(fs.readFileSync(path.join(b.outputDirectory, "baseline.json")), aBase);
  const body = queryProductGraph({ ...b, question: "changes", list: "content" });
  assert(body.rows.filter((row) => row.detail).every((row) => row.detail.before.status !== "available"));
  assert.match(body.text, /다른 기준의 보관 본문/);
});
