import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { productGraphWalk as walk } from "../scripts/graph-explorer/product-graph-walk.js";
import { buildProductGraph, checkProductGraph, readProductGraphBuild } from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import { baselineFromGraph, compareWithBaseline, addContentHashes, sourceTextHash, productGraphReader } from "../scripts/lib/world/product-graph-compare.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { fixture as coreFixture, snapshot as coreSnapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const syntheticScope = (reader) => ({
  projectId: null,
  sourceRootHash: sourceTextHash("synthetic-root"),
  parserSha256: sourceTextHash("synthetic-reader"),
  reader,
});
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
  for (const hit of hits) for (const edge of hit.connections) assert(edges.some((original) => JSON.stringify(original) === JSON.stringify(edge)));
  assert(hits.find((hit) => hit.node.id === "UA-01").basis.status === "추정");
  assert(
    !walk
      .search(ctx, "saveNote")
      .find((hit) => hit.node.id === "notes.mjs#saveNote")
      .connections.some((edge) => edge.to === "missing"),
  );
  assert.match(walk.ask(ctx, { question: "find", text: "메모", limit: 1 }).text, /승인·현재성·인과가 아니다/);
  const filtered = walk.ask(ctx, { question: "find", text: "저장", nodeTypes: ["기능"], relatedTo: "P1", edgeTypes: ["정책→기능"], limit: 1 });
  assert.equal(filtered.search.results[0].id, "cli:saveNote");
  assert.equal(filtered.page.total, 1);
  assert.equal(walk.search(ctx, "메모", { basisStates: ["추정"] })[0].node.id, "UA-01");
  assert.deepEqual(
    walk.find(ctx, "저장").map((n) => n.id),
    walk.find(ctx, "저장").map((n) => n.id),
  );
  const changed = structuredClone(ctx.graph);
  changed.nodes[0].oneLine = "메모 저장을 취소한다";
  const next = walk.ask(walk.context({ graph: changed }), { question: "find", text: "저장" });
  assert.equal(next.search.indexing.tokenizedNodes, 1);
  assert.equal(next.search.indexing.reusedNodeVectors, nodes.length - 1);
});

test("before/after uses retained normalized ranges and stated policy fields; a legacy baseline never invents old bodies", () => {
  const make = (text, action) => {
    const read = new Map([["x.mjs", text]]);
    const graph = {
      inputs: { reader: productGraphReader(1), sourceFiles: [{ path: "x.mjs", sha256: sourceTextHash(text) }], documents: [], rulesSha256: null },
      nodes: [
        { id: "x.mjs#f", type: "코드", kind: "function", file: "x.mjs", lines: [1, 1] },
        { id: "P1", type: "정책", 조건: "메모가 비었다", 주체: "CLI", 행위: action },
      ],
      edges: [],
    };
    addContentHashes(graph, read);
    return { graph, read };
  };
  const old = make("\ufefffunction f() { return 1; }\r\n", "막는다"),
    now = make("function f() { return 2; }\n", "설명한다");
  const scope = syntheticScope(old.graph.inputs.reader);
  const base = baselineFromGraph(old.graph, { setAt: "before", readFiles: old.read, scope });
  const beforeBytes = JSON.stringify(base);
  const changes = compareWithBaseline(now.graph, base, { readFiles: now.read, scope });
  assert.match(changes.contentChanges.find((c) => c.id === "x.mjs#f").before.text, /return 1/);
  assert.match(changes.contentChanges.find((c) => c.id === "x.mjs#f").after.text, /return 2/);
  assert.match(changes.contentChanges.find((c) => c.id === "P1").before.text, /막는다/);
  assert.equal(changes.interpretation.rawByteEquality, false);
  assert.equal(JSON.stringify(base), beforeBytes);
  const legacy = structuredClone(base);
  delete legacy.displayEvidence;
  assert(compareWithBaseline(now.graph, legacy, { readFiles: now.read, scope }).contentChanges.every((c) => c.before.status === "unavailable"));
  const corrupt = structuredClone(base);
  corrupt.displayEvidence["x.mjs#f"].text = "fiction";
  assert.equal(
    compareWithBaseline(now.graph, corrupt, { readFiles: now.read, scope }).contentChanges.find((c) => c.id === "x.mjs#f").before.status,
    "unavailable",
  );
  const wrongFullDigest = structuredClone(base);
  wrongFullDigest.displayEvidence["x.mjs#f"].fullTextSha256 = sourceTextHash("fiction");
  assert.equal(
    compareWithBaseline(now.graph, wrongFullDigest, { readFiles: now.read, scope }).contentChanges.find((c) => c.id === "x.mjs#f").before.status,
    "unavailable",
  );
});

test("cached builds equal full builds through unchanged, same-metadata edits, indirect calls, rules, rename, delete and cache loss", (t) => {
  const f = fixture(t),
    full = path.join(f.root, "full");
  const cold = buildProductGraph(f);
  assert(cold.processing.parsedFiles > 0);
  fs.mkdirSync(full);
  fs.copyFileSync(path.join(f.outputDirectory, "baseline.json"), path.join(full, "baseline.json"));
  const equivalent = () => {
    const result = buildProductGraph(f);
    buildProductGraph({ ...f, outputDirectory: full, incremental: false });
    for (const name of ["graph.json", "check.json", "check.txt"])
      assert.equal(fs.readFileSync(path.join(f.outputDirectory, name), "utf8"), fs.readFileSync(path.join(full, name), "utf8"), name);
    return result;
  };
  const unchanged = equivalent();
  assert.equal(unchanged.processing.parsedFiles, 0);
  assert(unchanged.processing.resolutionPassesReused > 0);
  assert(unchanged.processing.reachHashesReused > 0);
  assert.equal(unchanged.processing.documentChecks, "reused-same-topology-and-document-facts");
  const source = path.join(f.sourceRoot, "notes.mjs"),
    stat = fs.statSync(source);
  fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("return 1", "return 2"));
  fs.utimesSync(source, stat.atime, stat.mtime);
  const edited = equivalent();
  assert.equal(edited.processing.parsedFiles, 1);
  assert(edited.processing.reusedFiles > 0);
  assert(edited.processing.resolutionPassesReused > 0, "unchanged resolution contributions are retained under unchanged global facts");
  assert.equal(edited.processing.documentChecks, "reused-same-topology-and-document-facts");
  assert(edited.processing.reachHashesComputed > 0);
  assert(edited.changes.reachChanged.some((node) => node.id === "cli:notes"));
  assert(edited.changes.contentChanges.some((node) => node.before.text?.includes("return 1") && node.after.text?.includes("return 2")));
  put(f.documentsDirectory, "기능 뜻.md", "| 기능 | 뜻 |\n|---|---|\n| cli:notes | 메모 저장 |\n");
  assert.equal(equivalent().processing.documentChecks, "recomputed");
  put(f.root, "rules.json", '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[],"source":{"제외":[]}}\n');
  assert(equivalent().processing.parsedFiles > 0);
  fs.renameSync(source, path.join(f.sourceRoot, "renamed.mjs"));
  put(f.sourceRoot, "bin.mjs", 'import { saveNote } from "./renamed.mjs";\nsaveNote();\n');
  assert(equivalent().processing.parsedFiles >= 1);
  fs.unlinkSync(path.join(f.sourceRoot, "renamed.mjs"));
  equivalent();
  put(f.outputDirectory, "parse-cache.json", "broken");
  assert(equivalent().processing.parsedFiles > 0);
  fs.unlinkSync(path.join(f.outputDirectory, "parse-cache.json"));
  assert(equivalent().processing.parsedFiles > 0);
});

test("dependency contributions match full resolution for values, re-exports, classes, globals, dynamic table rows and UI; a global collision invalidates them", (t) => {
  const f = fixture(t),
    fixtures = path.resolve(import.meta.dirname, "fixtures/product-graph");
  for (const name of [
    "precision/values",
    "precision/reexports",
    "precision/members",
    "precision/builtins",
    "precision/imports",
    "precision/review/defaults",
    "precision/review/python",
    "table",
    "ui-dom",
    "ui-template",
  ]) {
    const sourceRoot = path.join(f.root, name),
      outputDirectory = path.join(f.root, name.replaceAll("/", "-") + "-out"),
      full = outputDirectory + "-full";
    fs.cpSync(path.join(fixtures, name), sourceRoot, { recursive: true });
    const options = { ...f, sourceRoot, outputDirectory };
    buildProductGraph(options);
    fs.mkdirSync(full);
    fs.copyFileSync(path.join(outputDirectory, "baseline.json"), path.join(full, "baseline.json"));
    const compare = () => {
      const cached = buildProductGraph(options);
      buildProductGraph({ ...options, outputDirectory: full, incremental: false });
      for (const file of ["graph.json", "check.json"]) assert.deepEqual(json(path.join(outputDirectory, file)), json(path.join(full, file)), `${name}/${file}`);
      return cached;
    };
    assert(compare().processing.resolutionPassesReused > 0, name);
    put(sourceRoot, "global-collision.mjs", "export function store() {}\nexport class Shared { run() {} }\n");
    const invalidated = compare();
    assert(invalidated.processing.resolutionPassesComputed > 0, name);
    assert.equal(invalidated.processing.resolutionPassesReused || 0, 0, name);
  }
});

test("meaning changes beyond entry and total display caps remain detectable without manufacturing an old body", () => {
  const graph = {
    inputs: { reader: productGraphReader(1), sourceFiles: [], documents: [], rulesSha256: null },
    edges: [],
    nodes: Array.from({ length: 140 }, (_, n) => ({
      id: `cli:${String(n).padStart(3, "0")}`,
      type: "기능",
      kind: "cli",
      handling: "경계로 둔다",
      oneLine: "a".repeat(17000) + "old",
      positions: [],
    })),
  };
  addContentHashes(graph, new Map());
  const scope = syntheticScope(graph.inputs.reader);
  const baseline = baselineFromGraph(graph, { setAt: "before", scope });
  const after = structuredClone(graph);
  after.nodes[0].oneLine = "a".repeat(17000) + "new";
  after.nodes.at(-1).oneLine = "a".repeat(17000) + "new";
  addContentHashes(after, new Map());
  const changes = compareWithBaseline(after, baseline, { scope });
  assert(changes.contentChanges.some((c) => c.id === "cli:000" && c.change === "display-changed"));
  assert(changes.contentChanges.some((c) => c.id === "cli:139" && c.change === "display-changed" && c.before.status === "unavailable"));
  assert(changes.displayCoverage.unavailableBefore > 0);
});

test("read-only check/query do not update cache, sources, baseline or candidate; CLI and common walk agree", async (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const files = ["graph.json", "check.json", "check.txt", "baseline.json", "parse-cache.json", "build-context.json"];
  const before = files.map((name) => fs.readFileSync(path.join(f.outputDirectory, name), "utf8"));
  checkProductGraph(f);
  const result = queryProductGraph({ ...f, question: "find", text: "saveNote" });
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

test("impact query uses existing builds only and never claims scope compatibility for unrelated roots or missing explicit origin", (t) => {
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
  const missing = queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate, proposalBaseBuildDirectory: path.join(f.root, "missing") });
  assert.equal(missing.impact.status, "unavailable");
  const metadataFile = path.join(candidate, "build-context.json"),
    metadata = json(metadataFile);
  metadata.scope.sourceRootHash = "unrelated";
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  assert.equal(
    queryProductGraph({ ...f, question: "impact", candidateBuildDirectory: candidate, proposalBaseBuildDirectory: base }).impact.compatibility.status,
    "partial",
  );
});

test("actual CLI and routed typed MCP consume the same impact without changing Canon, P2 or source files", async (t) => {
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
  assert.deepEqual(coreSnapshot(f.root), before);
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

test("R5: a foreign root baseline never supplies this Project's old body, while same-root history and legacy structural comparisons continue", (t) => {
  const a = fixture(t),
    b = fixture(t);
  buildProductGraph(a);
  const aBase = fs.readFileSync(path.join(a.outputDirectory, "baseline.json"));
  put(b.sourceRoot, "notes.mjs", "export function saveNote() { return 'project-B-current'; }\n");
  buildProductGraph(b);
  fs.writeFileSync(path.join(b.outputDirectory, "baseline.json"), aBase);
  const result = buildProductGraph(b);
  assert.equal(result.changes.status, "compared", "hash-only structural comparison remains available");
  assert.equal(result.changes.comparisonScope.status, "partial");
  assert(result.changes.comparisonScope.reasons.some((reason) => reason.includes("소스 루트")));
  assert(result.changes.contentChanges.every((change) => ["unavailable", "absent"].includes(change.before.status)));
  assert(result.changes.contentChanges.some((change) => change.after.text?.includes("project-B-current")));
  assert.match(result.text, /과거 표시 근거 partial/);
  assert.deepEqual(fs.readFileSync(path.join(b.outputDirectory, "baseline.json")), aBase);
  const body = queryProductGraph({ ...b, question: "changes", list: "content" });
  assert.match(body.header[2], /이전 본문 unavailable/);
  const prior = json(path.join(a.outputDirectory, "baseline.json"));
  delete prior.scope;
  fs.writeFileSync(path.join(a.outputDirectory, "baseline.json"), JSON.stringify(prior));
  assert.equal(buildProductGraph(a).changes.comparisonScope.status, "partial");
  assert.equal(buildProductGraph(a).changes.status, "compared");
});
