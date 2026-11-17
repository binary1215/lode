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

test("T5: a line shift above an entry point does not list its 기능 as changed content", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  // The entry point is recorded in package.json: move its line down.
  put(f.sourceRoot, "package.json", '{\n  "name": "notes",\n  "bin": { "notes": "bin.mjs" }\n}\n');
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

test("N4/M7: three different states from the same Project (start, proposal on the start, current) compare as verified over CLI and MCP; nothing is applied", async (t) => {
  const f = coreFixture(t),
    synthetic = fixture(t);
  fs.cpSync(synthetic.sourceRoot, f.root, { recursive: true });
  const current = path.join(f.root, ".lode/context/product-graph/build"),
    start = path.join(f.base, "start"),
    proposal = path.join(f.base, "proposal");
  const notes = (store) => put(f.root, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() { return ${store}; }\n`);
  // The documented steps: build the starting state and keep a copy; apply the
  // proposal to it, build and keep a copy; go back to the current state and build.
  notes(1);
  buildProductGraph({ root: f.root });
  fs.cpSync(current, start, { recursive: true });
  notes("'proposed'");
  buildProductGraph({ root: f.root });
  fs.cpSync(current, proposal, { recursive: true });
  notes("'current'");
  buildProductGraph({ root: f.root });
  const before = coreSnapshot(f.root);
  const cli = await runCommand(["product-graph-query", f.root, "impact", "--proposal-base-build", start, "--candidate-build", proposal]);
  assert.equal(cli.impact.compatibility.status, "verified", JSON.stringify(cli.impact.compatibility));
  // Three different states: both sides changed the same declaration differently.
  assert.ok(cli.impact.counts.currentChanges > 0);
  assert.ok(cli.impact.counts.proposedChanges > 0);
  assert.ok(cli.impact.counts.conflicts > 0, JSON.stringify(cli.impact));
  assert.equal(cli.impact.structuralConflictFree, false);
  assert.equal(cli.impact.productApproved, false);
  const mcp = await dispatch({
    jsonrpc: "2.0",
    id: "impact",
    method: "tools/call",
    params: {
      name: "lode_tools_call",
      arguments: {
        name: "lode_product_graph_query",
        arguments: { project_root: f.root, question: "impact", proposal_base_build: start, candidate_build: proposal },
      },
    },
  });
  assert.equal(mcp.error, undefined);
  const presented = mcp.result.content[0].text;
  assert(presented.startsWith(cli.text));
  const structured = mcp.result.structuredContent || JSON.parse(presented.split("구조화된 결과:\n")[1]);
  assert.deepEqual(structured.impact, cli.impact);
  assert.equal(structured.basisSha256, cli.basisSha256);
  // Read-only: nothing in the Project changed.
  assert.deepEqual(coreSnapshot(f.root), before);
  // A stand-alone --out candidate of the same source next to Project builds is partial, and says why.
  const standalone = path.join(f.base, "standalone");
  const rules = path.join(f.base, "rules.json");
  fs.writeFileSync(rules, '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[]}\n');
  fs.mkdirSync(path.join(f.base, "documents"));
  buildProductGraph({ sourceRoot: f.root, documentsDirectory: path.join(f.base, "documents"), rulesFile: rules, outputDirectory: standalone });
  const mixed = await runCommand(["product-graph-query", f.root, "impact", "--proposal-base-build", start, "--candidate-build", standalone]);
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

test("T2/N2: a side is bounded and says what it left out; a page shows whole items only and the next page starts at the first one left out", (t) => {
  const f = fixture(t);
  const long = (n, tail) => `function big${n}() { return "${"x".repeat(15 * 1024)}${tail}"; }`;
  const write = (tail) =>
    put(
      f.sourceRoot,
      "notes.mjs",
      ["export function saveNote() { return store(); }", "function store() { return 1; }", ...Array.from({ length: 24 }, (_, n) => long(n, tail))].join("\n") +
        "\n",
    );
  write("a");
  buildProductGraph(f);
  write("b");
  buildProductGraph(f);
  const all = queryProductGraph({ ...f, question: "changes", list: "content", limit: 50 });
  assert.equal(all.status, "answered");
  // 24 changed declarations of ~15 KiB each side: the 256 KiB page holds only some of them.
  const shown = all.rows.filter((row) => row.detail?.after).length;
  assert.ok(shown > 1 && shown < 24, String(shown));
  assert.equal(all.page.cursor + shown, all.page.nextCursor);
  const total = all.page.total;
  // Walking the pages by their hints shows every item exactly once.
  const seen = [];
  let page = all;
  for (let i = 0; i < 20 && page; i += 1) {
    for (const row of page.rows.filter((item) => item.detail?.after)) seen.push(row.detail.id);
    page = page.page?.remaining ? queryProductGraph({ ...f, ...page.page.nextArguments }) : null;
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  // The structured reply holds each text once (rows[].detail); rows[].text keeps the first line.
  const item = all.rows.find((row) => row.detail?.after?.text);
  assert.equal(item.text.includes("\n"), false);
  // A side over its own bound says so; a "before" over the retained bound was not kept.
  const longer = "z".repeat(20 * 1024);
  put(f.sourceRoot, "notes.mjs", `export function saveNote() { return store(); }\nfunction store() { return "${longer}"; }\n`);
  const rebuilt = buildProductGraph(f);
  const at = rebuilt.changes.contentChanges.findIndex((item) => item.id === "notes.mjs#store");
  const store = queryProductGraph({ ...f, question: "changes", list: "content", cursor: at, limit: 1 }).rows.find(
    (row) => row.detail?.id === "notes.mjs#store",
  ).detail;
  assert.equal(store.after.status, "partial");
  assert.ok(store.after.omittedBytes > 0);
  assert.match(store.after.omittedBecause, /한 쪽 한도/);
});

test("T4/N7: only whole contents are kept, smallest first; Korean-ID documents keep theirs; too large or over budget has no entry; every kept entry is checked", () => {
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
  assert.ok(document.entries["화면-가"]);
  assert.ok(document.entries["UA-가-01"]);
  assert.equal(document.entries["x.mjs"], undefined, "the whole file is larger than the per-node bound");
  assert.equal(document.counts.tooLarge, 1);
  assert.ok(document.counts.overBudget > 0);
  assert.equal(Object.keys(document.entries).length, document.counts.kept);
  assert.ok(document.counts.bytes <= budget.totalBytes);
  for (const entry of Object.values(document.entries)) assert.deepEqual(Object.keys(entry).sort(), ["format", "text"]);
});

test("N7: an entry edited by hand, whatever it claims about itself, is not shown", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const contentFile = path.join(f.outputDirectory, "baseline-content.json");
  const document = json(contentFile);
  const [id] = Object.keys(document.entries).filter((key) => key.includes("#"));
  document.entries[id] = { format: "source-lines", complete: false, totalBytes: 999, text: "function invented() {" };
  fs.writeFileSync(contentFile, JSON.stringify(document));
  const read = readRetainedContent(contentFile, {
    baseline: json(path.join(f.outputDirectory, "baseline.json")),
    baselineBytes: fs.readFileSync(path.join(f.outputDirectory, "baseline.json")),
  });
  assert.equal(read.entries.has(id), false);
});

test("N1/N10: after a baseline move, or for a build without a bound comparison, the content list is refused with no text until a build", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  put(f.sourceRoot, "notes.mjs", "export function saveNote() { return store(); }\nfunction store() { return 'EDITED-LINE'; }\n");
  buildProductGraph(f);
  assert.match(queryProductGraph({ ...f, question: "changes", list: "content" }).text, /EDITED-LINE/);
  moveProductGraphBaseline(f);
  const stale = queryProductGraph({ ...f, question: "changes", list: "content" });
  assert.equal(stale.status, "refused");
  assert.equal(stale.code, "PRODUCT_GRAPH_BUILD_STALE");
  assert.doesNotMatch(stale.text, /EDITED-LINE/);
  assert.match(stale.text, /다시 빌드/);
  buildProductGraph(f);
  assert.equal(queryProductGraph({ ...f, question: "changes", list: "content" }).status, "answered");
  // A build whose comparison names no baseline (made before retained content existed).
  const checkFile = path.join(f.outputDirectory, "check.json");
  const check = json(checkFile);
  delete check.changes.content;
  fs.writeFileSync(checkFile, JSON.stringify(check));
  const old = queryProductGraph({ ...f, question: "changes", list: "content" });
  assert.equal(old.code, "PRODUCT_GRAPH_BUILD_STALE");
  assert.match(old.text, /이전 버전이 만든 빌드/);
});

test("N6/N8: a baseline read another way gets no retained file and the same check twice; a retained file for another baseline or unreadable is written again", (t) => {
  const f = fixture(t);
  buildProductGraph(f);
  const contentFile = path.join(f.outputDirectory, "baseline-content.json"),
    baselineFile = path.join(f.outputDirectory, "baseline.json");
  const baseline = json(baselineFile);
  fs.rmSync(contentFile);
  fs.writeFileSync(baselineFile, JSON.stringify({ ...baseline, reader: { ...baseline.reader, sourceAnalysis: "another" } }));
  const first = buildProductGraph(f);
  assert.equal(fs.existsSync(contentFile), false);
  assert.equal(first.changes.content.retainedFile.status, "other-reader");
  assert.match(first.changes.content.retainedFile.action, /product-graph-baseline/);
  const checkOnce = fs.readFileSync(path.join(f.outputDirectory, "check.json"));
  buildProductGraph(f);
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, "check.json")), checkOnce);
  // Same reader again: an unreadable retained file, and one for another baseline, are written again.
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  fs.writeFileSync(contentFile, "{");
  buildProductGraph(f);
  assert.equal(readRetainedContent(contentFile, { baseline: json(baselineFile), baselineBytes: fs.readFileSync(baselineFile) }).status, "read");
  const other = json(contentFile);
  other.baselineSha256 = "0".repeat(64);
  fs.writeFileSync(contentFile, JSON.stringify(other));
  const healed = buildProductGraph(f);
  assert.equal(healed.changes.content.retainedFile.status, "read");
  assert.equal(readRetainedContent(contentFile, { baseline: json(baselineFile), baselineBytes: fs.readFileSync(baselineFile) }).status, "read");
});

test("N3: the next page over MCP, with exactly the arguments the first page returned", async (t) => {
  const f = coreFixture(t);
  put(f.root, "package.json", '{"bin":{"notes":"bin.mjs"}}\n');
  put(f.root, "bin.mjs", 'import { saveNote } from "./notes.mjs";\nsaveNote();\n');
  put(f.root, "notes.mjs", Array.from({ length: 8 }, (_, n) => `export function noteHelper${n}() { return ${n}; }`).join("\n") + "\n");
  buildProductGraph({ root: f.root });
  const call = async (args) => {
    const reply = await dispatch({
      jsonrpc: "2.0",
      id: "q",
      method: "tools/call",
      params: { name: "lode_tools_call", arguments: { name: "lode_product_graph_query", arguments: args } },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result.structuredContent || JSON.parse(reply.result.content[0].text.split("구조화된 결과:\n")[1]);
  };
  const first = await call({ project_root: f.root, question: "find", text: "noteHelper", node_types: ["코드"], limit: 2 });
  assert.ok(first.page.remaining > 0);
  assert.equal(first.page.nextMcpArguments.project_root, f.root);
  const second = await call(first.page.nextMcpArguments);
  assert.equal(second.status, "answered");
  assert.equal(second.page.cursor, 2);
  assert.notDeepEqual(
    second.search.results.map((item) => item.id),
    first.search.results.map((item) => item.id),
  );
});

test("N13: the next-page hints of gaps, down and impact repeat the question", (t) => {
  const f = fixture(t);
  put(
    f.sourceRoot,
    "notes.mjs",
    ["export function saveNote() { a0(); a1(); a2(); a3(); a4(); }", ...Array.from({ length: 5 }, (_, n) => `function a${n}() { return ${n}; }`)].join("\n") +
      "\n",
  );
  buildProductGraph(f);
  const base = path.join(f.root, "base");
  fs.cpSync(f.outputDirectory, base, { recursive: true });
  const down = queryProductGraph({ ...f, question: "down", id: "notes.mjs#saveNote", limit: 2 });
  assert.match(down.rows.find((row) => row.kind === "more").text, /down notes\.mjs#saveNote --cursor 2 .*--limit 2 .*--expected-basis-sha256 [a-f0-9]{64}/);
  const gaps = queryProductGraph({ ...f, question: "gaps", list: "unreachedCode", limit: 1 });
  if (gaps.page?.remaining) assert.match(gaps.rows.find((row) => row.kind === "more").text, /--limit 1 .*--expected-basis-sha256/);
  else t.diagnostic("no second page of unreachedCode in this fixture");
  put(
    f.sourceRoot,
    "notes.mjs",
    ["export function saveNote() { a0(); }", ...Array.from({ length: 5 }, (_, n) => `function a${n}() { return ${n + 10}; }`)].join("\n") + "\n",
  );
  const candidate = path.join(f.root, "candidate");
  buildProductGraph({ ...f, outputDirectory: candidate });
  const impact = queryProductGraph({ ...f, question: "impact", proposalBaseBuildDirectory: base, candidateBuildDirectory: candidate, limit: 1 });
  const more = impact.rows.find((row) => row.kind === "more");
  assert.ok(more, "the impact answer has a next page");
  assert.match(more.text, /impact --cursor 1 .*--limit 1 .*--candidate-build .*--proposal-base-build .*--expected-basis-sha256 [a-f0-9]{64}/);
  const next = queryProductGraph({ ...f, ...impact.page.nextArguments });
  assert.equal(next.status, "answered");
});

test("R5: a baseline brought from another folder: its retained file is written again from this folder's sources, only for content equal to that baseline's", (t) => {
  const a = fixture(t),
    b = fixture(t);
  buildProductGraph(a);
  const aBase = fs.readFileSync(path.join(a.outputDirectory, "baseline.json"));
  put(b.sourceRoot, "notes.mjs", "export function saveNote() { return 'project-B-current'; }\n");
  buildProductGraph(b);
  fs.writeFileSync(path.join(b.outputDirectory, "baseline.json"), aBase);
  const result = buildProductGraph(b);
  assert.equal(result.changes.status, "compared", "the structural comparison continues");
  assert.equal(result.changes.content.retainedFile.status, "read");
  // The node B changed has no "before": B never had A's text for it.
  assert.equal(result.changes.contentChanges.find((change) => change.id === "notes.mjs#saveNote").beforeRetained, false);
  assert.deepEqual(fs.readFileSync(path.join(b.outputDirectory, "baseline.json")), aBase);
  const body = queryProductGraph({ ...b, question: "changes", list: "content" });
  assert.equal(body.rows.find((row) => row.detail?.id === "notes.mjs#saveNote").detail.before.status, "unavailable");
});
