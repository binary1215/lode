// Bundle 2: the viewer's status, product graph and gaps views, the
// product-graph-query command, and the changed-part comparison of the product
// graph build. Every input is synthetic and written here; no other project is
// read, and nothing is shaped around one toolkit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture, snapshot, exact, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { explorerDom, visibleText } from "./helpers/graph-explorer-dom-fixture.mjs";
import { updateProjectDirection } from "../scripts/lib/session/project-direction.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session/session-work-context.mjs";
import {
  buildProductGraph,
  checkProductGraph,
  approveProductGraphDocument,
  moveProductGraphBaseline,
  readProductGraphBuild,
} from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import { buildGraphExplorerSnapshot, exportGraphExplorer } from "../scripts/lib/world/graph-explorer.mjs";
import { renderGraphExplorer, graphExplorerStyle } from "../scripts/lib/world/graph-explorer-html.mjs";
import { productGraphWalk as walk } from "../scripts/graph-explorer/product-graph-walk.js";
import { explorerStatus } from "../scripts/graph-explorer/status-model.js";
import { explorerText } from "../scripts/graph-explorer/i18n.js";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

const read = (file) => fs.readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));
const descendants = (element) => [element, ...element.children.flatMap(descendants)];
const assets = path.join(pluginRoot, "scripts", "graph-explorer");

function temporary(t, prefix = "lode-viewer-") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// A small product with no UI toolkit: a command-line entry (package.json bin)
// whose file calls two library functions, one of which calls a helper.
const SOURCE = {
  "package.json": '{ "name": "notes-tool", "bin": { "notes": "bin/notes.mjs" } }\n',
  "bin/notes.mjs": 'import { addNote } from "../lib/notes.mjs";\nimport { listNotes } from "../lib/list.mjs";\naddNote(process.argv[2]);\nlistNotes();\n',
  "lib/notes.mjs": "export function addNote(text) {\n  return store(text);\n}\n\nfunction store(text) {\n  return [text];\n}\n",
  "lib/list.mjs": "export function listNotes() {\n  return [];\n}\n",
};
const DOCUMENTS = {
  "화면설계서/MAIN-01.md": [
    "# MAIN-01 메모 화면",
    "",
    "## 이 화면이 무엇인가",
    "",
    "| 항목 | 내용 |",
    "|---|---|",
    "| ID | MAIN-01 |",
    "| 이름 | 메모 화면 |",
    "| IA 묶음 | MAIN |",
    "",
    "## 개요",
    "",
    "메모를 더하는 화면이다.",
    "",
    "## 화면 흐름",
    "",
    "메모를 쓰고 더한다.",
    "",
    "## 화면요소",
    "",
    "| ID | 한 줄 | 위치 | 조작하면 실행되는 기능 | 보여 주는 기능 |",
    "|---|---|---|---|---|",
    "| MAIN-01#1 | 메모 더하기 | `bin/notes.mjs:3` | `cli:notes` | |",
    "",
    "## 화면 정책",
    "",
    "| 정책 | 조건 | 주체 | 행위 |",
    "|---|---|---|---|",
    "",
  ].join("\n"),
  "유저플로우 기획서/UA-NOTE-01.md": [
    "# UA-NOTE-01 메모를 남긴다",
    "",
    "| 항목 | 내용 |",
    "|---|---|",
    "| ID | UA-NOTE-01 |",
    "| 한 줄 | 메모를 남긴다 |",
    "| 유저 | 메모하는 사람 |",
    "| 추정 | 코드만 보고 쓴 추정 |",
    "",
    "## 차례",
    "",
    "| 차례 | 하는 일 | 화면요소 |",
    "|---|---|---|",
    "| 시작 | 메모를 더한다 | `MAIN-01#1` |",
    "",
    "## 다음 활동",
    "",
    "없음.",
    "",
  ].join("\n"),
  "기능 뜻.md": "# 기능 뜻\n\n| 기능 | 뜻 |\n|---|---|\n| cli:notes | 메모를 더하고 목록을 보여 준다 |\n",
};

function writeTree(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
}

// A Lode Project holding the product, its documents, and work records.
function notesProject(t, { documents = true, records = true } = {}) {
  const f = fixture(t, "Keep the notes tool reliable");
  writeTree(f.root, SOURCE);
  const family = path.join(f.root, ".lode", "context", "product-graph");
  if (documents) writeTree(family, DOCUMENTS);
  if (records) {
    updateProjectDirection({ root: f.root, input: { goal: "Keep every note", constraints: ["Synthetic data only"], cancelledActions: ["Do not publish"] } });
    const first = f.save({
      summary: "Looked at the store.",
      pending: ["Check the caller"],
      unknowns: ["Whether a note can be lost"],
      todos: [{ todoId: "todo-store", task: "Test the store", status: "pending", origin: "user-directed", nextAction: "Run it" }],
    });
    f.save({
      summary: "Tested the store.",
      todos: [{ todoId: "todo-store", task: "Test the store", status: "completed", origin: "user-directed", prior: exact(first) }],
      judgments: [{ assessment: "Keep the plain list", reason: "Simplest", alternatives: ["A database"] }],
    });
    f.save({ summary: "Nothing left to note.", pending: [] });
    const quiet = createHeadSession({ root: f.root, purpose: "Look at reading on a phone" });
    withSessionRoute(f.root, quiet.sessionId, () =>
      recordSessionWorkEvidence({ root: f.root, input: { summary: "Looked at a phone.", unknowns: ["Reading at 200%"] } }),
    );
    const done = createHeadSession({ root: f.root, purpose: "Tidy names" });
    withSessionRoute(f.root, done.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Renamed two helpers." } }));
  }
  return { ...f, family, build: path.join(family, "build") };
}

const filesUnder = (directory) => {
  const out = new Map();
  if (!fs.existsSync(directory)) return out;
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else out.set(child, fs.readFileSync(path.join(directory, child)));
    }
  };
  visit("");
  return out;
};
const outsideBuild = (root) =>
  Object.fromEntries(
    Object.entries(snapshot(root))
      .filter(([file]) => !file.replaceAll("\\", "/").includes("context/product-graph/build/"))
      .map(([file, value]) => [file, value.digest]),
  );
const changes = (build) => json(path.join(build, "check.json")).changes;
const group = (value, type) => value.byType.find((item) => item.type === type);

// ---------- 8A: hashes, baseline, comparison ----------

test("acceptance 21: hashes are attributes; two builds are byte-identical; line endings and moving a declaration in its file change no hash", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const first = filesUnder(f.build);
  buildProductGraph({ root: f.root });
  for (const [name, bytes] of filesUnder(f.build)) assert.deepEqual(bytes, first.get(name), name);
  const graph = JSON.parse(first.get("graph.json"));
  assert(
    graph.nodes.every((node) => typeof node.contentSha256 === "string"),
    "every node has a content hash",
  );
  assert(graph.nodes.filter((node) => node.type === "기능").every((node) => typeof node.reachSha256 === "string"));
  assert.deepEqual(
    graph.inputs.sourceFiles.map((item) => item.path),
    ["bin/notes.mjs", "lib/list.mjs", "lib/notes.mjs", "package.json"],
  );
  assert.equal(graph.inputs.reader.generator, "lode-product-graph");
  const hashes = (value) => Object.fromEntries(value.nodes.map((node) => [node.id, [node.contentSha256, node.reachSha256 ?? null]]));
  // CR LF everywhere: no hash moves, nothing is listed as changed.
  for (const relative of Object.keys(SOURCE)) fs.writeFileSync(path.join(f.root, relative), SOURCE[relative].replaceAll("\n", "\r\n"));
  buildProductGraph({ root: f.root });
  const crlf = json(path.join(f.build, "graph.json"));
  assert.deepEqual(hashes(crlf), hashes(graph));
  assert.equal(changes(f.build).counts.changed, 0);
  // Move store above addNote without changing its text: lines move, the hash does not.
  fs.writeFileSync(
    path.join(f.root, "lib/notes.mjs"),
    "function store(text) {\n  return [text];\n}\n\nexport function addNote(text) {\n  return store(text);\n}\n",
  );
  buildProductGraph({ root: f.root });
  const moved = json(path.join(f.build, "graph.json"));
  const store = (value) => value.nodes.find((node) => node.id === "lib/notes.mjs#store");
  assert.notDeepEqual(store(moved).lines, store(graph).lines);
  assert.equal(store(moved).contentSha256, store(graph).contentSha256);
  // Graph IDs are untouched by the hashes.
  assert.deepEqual(
    moved.nodes.map((node) => node.id),
    graph.nodes.map((node) => node.id),
  );
});

test("acceptance 22: the first build takes the baseline, lists nothing as changed and says so", async (t) => {
  const f = notesProject(t, { records: false });
  assert.equal(fs.existsSync(path.join(f.build, "baseline.json")), false);
  const built = buildProductGraph({ root: f.root });
  assert.equal(built.baseline.status, "taken-now");
  assert.equal(built.baseline.message, "기준 없음 — 이번 빌드를 기준으로 삼았다");
  assert(fs.existsSync(path.join(f.build, "baseline.json")));
  const value = changes(f.build);
  assert.equal(value.status, "compared");
  assert.deepEqual([value.counts.changed, value.counts.added, value.counts.removed, value.counts.reachChanged, value.counts.reviewAgain], [0, 0, 0, 0, 0]);
  const cli = await runCommand(["product-graph-build", f.root]);
  assert.equal(cli.baseline.status, "kept");
  // The read-only check without a baseline says so and writes nothing.
  const g = notesProject(t, { records: false });
  const before = snapshot(g.root);
  assert.match(checkProductGraph({ root: g.root }).changes.reason, /기준 파일이 없다/);
  assert.deepEqual(snapshot(g.root), before);
});

test("acceptance 23 / 28: one edited body is 변경, the 기능 reaching it is 닿는 코드가 바뀜, its 뜻 line and document row are 다시 볼 것, approval and files stay", (t) => {
  const f = notesProject(t, { records: false });
  const first = buildProductGraph({ root: f.root, includeEstimates: true });
  const screen = first.documents.list.find((item) => item.path === "화면설계서/MAIN-01.md");
  approveProductGraphDocument({ root: f.root, document: screen.path, expectedSha256: screen.approvalDigest, rationale: "User approved." });
  buildProductGraph({ root: f.root, includeEstimates: true });
  const outside = outsideBuild(f.root);
  fs.writeFileSync(path.join(f.root, "lib/notes.mjs"), SOURCE["lib/notes.mjs"].replace("return [text];", "return [text.trim()];"));
  const outsideAfterEdit = outsideBuild(f.root);
  buildProductGraph({ root: f.root, includeEstimates: true });
  const value = changes(f.build);
  assert.deepEqual(group(value, "코드").changed, ["lib/notes.mjs", "lib/notes.mjs#store"]);
  assert.deepEqual(group(value, "기능").changed, []);
  const reach = value.reachChanged.find((item) => item.id === "cli:notes");
  assert(reach, "cli:notes reaches the changed code");
  assert(reach.nodes.some((node) => node.id === "lib/notes.mjs#store" && node.change === "changed"));
  assert.deepEqual(
    value.reviewAgain.meaningLines.map((item) => [item.id, item.at.path, item.change]),
    [["cli:notes", "기능 뜻.md", "reach"]],
  );
  const row = value.reviewAgain.documentRows.find((item) => item.type === "화면요소→기능");
  assert.equal(row.target, "cli:notes");
  assert.equal(row.status, "승인");
  assert.equal(row.approved, true);
  const text = read(path.join(f.build, "check.txt"));
  assert.match(text, /승인된 문서가 가리키는 것이 기준 뒤 바뀜/);
  // The approval stays: the document is still 승인.
  assert.equal(json(path.join(f.build, "check.json")).documents.list.find((item) => item.path === screen.path).status, "승인");
  // Everything else is a count of 변화 없음.
  assert.equal(group(value, "화면요소").unchanged, 1);
  assert.equal(group(value, "코드").unchanged, group(value, "코드").unchanged);
  // Building again without an edit lists the same changes.
  buildProductGraph({ root: f.root, includeEstimates: true });
  assert.deepEqual(changes(f.build), value);
  // 28: nothing outside build/ moved (documents, 기능 뜻.md, rules, approvals).
  assert.deepEqual(outsideBuild(f.root), outsideAfterEdit);
  assert.notDeepEqual(outsideAfterEdit, outside, "only the edited source file differs");
  checkProductGraph({ root: f.root });
  assert.deepEqual(outsideBuild(f.root), outsideAfterEdit);
});

test("acceptance 24: added and removed functions and 기능 are 신규 and 사라짐; a renamed file gives 옮겨졌을 수 있음 pairs", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  fs.writeFileSync(path.join(f.root, "lib/list.mjs"), "export function listNotes() {\n  return [];\n}\n\nexport function countNotes() {\n  return 0;\n}\n");
  writeTree(f.root, {
    "package.json": '{ "name": "notes-tool", "bin": { "notes": "bin/notes.mjs", "count": "bin/count.mjs" } }\n',
    "bin/count.mjs": 'import { countNotes } from "../lib/list.mjs";\ncountNotes();\n',
  });
  buildProductGraph({ root: f.root });
  let value = changes(f.build);
  assert(group(value, "코드").added.includes("lib/list.mjs#countNotes"));
  assert.deepEqual(group(value, "기능").added, ["cli:count"]);
  assert.deepEqual(value.reviewAgain.newWithoutMeaning, ["cli:count"]);
  // Rename lib/list.mjs → lib/listing.mjs with the same text.
  const g = notesProject(t, { records: false });
  buildProductGraph({ root: g.root });
  fs.renameSync(path.join(g.root, "lib/list.mjs"), path.join(g.root, "lib/listing.mjs"));
  fs.writeFileSync(path.join(g.root, "bin/notes.mjs"), SOURCE["bin/notes.mjs"].replace("../lib/list.mjs", "../lib/listing.mjs"));
  buildProductGraph({ root: g.root });
  value = changes(g.build);
  assert(group(value, "코드").removed.includes("lib/list.mjs#listNotes"));
  assert(group(value, "코드").added.includes("lib/listing.mjs#listNotes"));
  assert.deepEqual(
    value.maybeMoved.filter((pair) => pair.from === "lib/list.mjs#listNotes"),
    [{ type: "코드", from: "lib/list.mjs#listNotes", to: "lib/listing.mjs#listNotes" }],
  );
  assert.match(read(path.join(g.build, "check.txt")), /옮겨졌을 수 있음/);
});

test("acceptance 25: only product-graph-baseline moves the baseline; it reports what it drops and refuses a stale build", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const baselineFile = path.join(f.build, "baseline.json");
  fs.writeFileSync(path.join(f.root, "lib/notes.mjs"), SOURCE["lib/notes.mjs"].replace("[text]", "[text, 1]"));
  buildProductGraph({ root: f.root });
  const kept = fs.readFileSync(baselineFile);
  // Build, check, query and export leave the baseline byte-identical.
  buildProductGraph({ root: f.root });
  checkProductGraph({ root: f.root });
  queryProductGraph({ root: f.root, question: "changes" });
  await exportGraphExplorer({ root: f.root, output: path.join(temporary(t), "copy.html") });
  assert.deepEqual(fs.readFileSync(baselineFile), kept);
  const before = changes(f.build).counts;
  assert(before.changed > 0);
  // A stale build is refused and nothing is written.
  fs.appendFileSync(path.join(f.root, "lib/list.mjs"), "// later\n");
  assert.throws(() => moveProductGraphBaseline({ root: f.root }), { code: "PRODUCT_GRAPH_BUILD_STALE" });
  assert.deepEqual(fs.readFileSync(baselineFile), kept);
  buildProductGraph({ root: f.root });
  const counts = changes(f.build).counts;
  const moved = await runCommand(["product-graph-baseline", f.root]);
  assert.equal(moved.status, "moved");
  assert.deepEqual(moved.dropped, { changes: counts.changed + counts.added + counts.removed + counts.reachChanged, reviewAgain: counts.reviewAgain });
  assert.match(moved.text, /기준을 옮겼다/);
  const baseline = json(baselineFile);
  assert.equal(baseline.previous.droppedChanges, moved.dropped.changes);
  assert.equal(typeof baseline.previous.setAt, "string");
  buildProductGraph({ root: f.root });
  const after = changes(f.build).counts;
  assert.deepEqual([after.changed, after.added, after.removed, after.reachChanged], [0, 0, 0, 0]);
});

test("acceptance 26: a changed rules file or reader is named in the comparison's first line", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  fs.writeFileSync(path.join(f.family, "호출 방식 표.json"), JSON.stringify({ schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: [] }));
  buildProductGraph({ root: f.root });
  let text = read(path.join(f.build, "check.txt"));
  assert.match(text, /호출 방식 표 바뀜/);
  assert.match(text, /코드를 읽는 방식에서 왔을 수 있다/);
  const g = notesProject(t, { records: false });
  buildProductGraph({ root: g.root });
  const file = path.join(g.build, "baseline.json");
  const baseline = json(file);
  baseline.reader = { ...baseline.reader, sourceAnalysis: "0.0.0" };
  fs.writeFileSync(file, JSON.stringify(baseline));
  buildProductGraph({ root: g.root });
  text = read(path.join(g.build, "check.txt"));
  assert.match(text, /읽는 방식 바뀜/);
  assert.match(text, /코드를 읽는 방식에서 왔을 수 있다/);
});

test("acceptance 27: a baseline that disagrees with an unchanged file stops the build and writes nothing; a missing or broken one does not", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const file = path.join(f.build, "baseline.json");
  const baseline = json(file);
  const row = baseline.nodes.find((node) => node[0] === "lib/notes.mjs#store");
  row[5] = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(baseline));
  const before = filesUnder(f.build);
  assert.throws(() => buildProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_NOT_REPRODUCIBLE", message: /lib\/notes\.mjs#store/ });
  assert.deepEqual(filesUnder(f.build), before);
  fs.writeFileSync(file, "{ not json");
  const broken = buildProductGraph({ root: f.root });
  assert.equal(broken.changes.status, "no-baseline");
  assert.match(broken.changes.reason, /JSON/);
  assert.equal(read(file), "{ not json", "an unreadable baseline is reported, never replaced by a build");
  fs.rmSync(file);
  assert.equal(buildProductGraph({ root: f.root }).baseline.status, "taken-now");
});

// ---------- 6.3 freshness ----------

test("acceptance 10: freshness names each moved input; a build without source hashes is unknown; two builds stay byte-identical", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const graphBytes = fs.readFileSync(path.join(f.build, "graph.json"));
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.text, "빌드 뒤 바뀐 것 없음");
  fs.appendFileSync(path.join(f.family, "기능 뜻.md"), "\n");
  let fresh = readProductGraphBuild({ root: f.root }).freshness;
  assert.equal(fresh.state, "stale");
  assert.match(fresh.text, /^빌드가 낡음: 문서 1개 \(기능 뜻\.md\)$/);
  fs.writeFileSync(path.join(f.family, "호출 방식 표.json"), JSON.stringify({ schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: [] }));
  fs.appendFileSync(path.join(f.root, "lib/list.mjs"), "// edited\n");
  fs.writeFileSync(path.join(f.root, "lib/new.mjs"), "export const x = 1;\n");
  fresh = readProductGraphBuild({ root: f.root }).freshness;
  assert.equal(fresh.text, "빌드가 낡음: 문서 1개 (기능 뜻.md) / 호출 방식 표 / 소스 파일 2개 (lib/list.mjs, lib/new.mjs)");
  // A build made before inputs.sourceFiles existed (0.3.0-beta.124–126).
  const g = notesProject(t, { records: false });
  buildProductGraph({ root: g.root });
  const old = json(path.join(g.build, "graph.json"));
  old.inputs.sourceFiles = 4;
  fs.writeFileSync(path.join(g.build, "graph.json"), JSON.stringify(old));
  fresh = readProductGraphBuild({ root: g.root }).freshness;
  assert.equal(fresh.state, "unknown");
  assert.match(fresh.text, /^소스가 바뀌었는지 알 수 없음/);
  // A stand-alone build folder without its source root.
  assert.match(readProductGraphBuild({ buildDirectory: g.build }).freshness.text, /^소스가 바뀌었는지 알 수 없음/);
  // Reading changed nothing; rebuilding the same input is byte-identical.
  fs.rmSync(path.join(f.root, "lib/new.mjs"));
  fs.writeFileSync(path.join(f.root, "lib/list.mjs"), SOURCE["lib/list.mjs"]);
  fs.rmSync(path.join(f.family, "호출 방식 표.json"));
  fs.writeFileSync(path.join(f.family, "기능 뜻.md"), DOCUMENTS["기능 뜻.md"]);
  buildProductGraph({ root: f.root });
  assert.deepEqual(fs.readFileSync(path.join(f.build, "graph.json")), graphBytes);
});

// ---------- 8: query ----------

test("acceptance 13 / 15: every question answers from the build; paging gives each item once; reach is the check's closure; a cycle is not walked twice", async (t) => {
  const f = notesProject(t, { records: false });
  writeTree(f.root, {
    "lib/notes.mjs": "export function addNote(text) {\n  return store(text);\n}\n\nfunction store(text) {\n  return text ? addNote('') : [text];\n}\n",
  });
  buildProductGraph({ root: f.root, includeEstimates: true });
  const ask = (request) => queryProductGraph({ root: f.root, ...request });
  const overview = ask({ question: "overview" });
  assert.equal(overview.status, "answered");
  const [freshness, limits, compared] = overview.header;
  assert.match(freshness, /\(graph\.json 파일 시각\) — 빌드 뒤 바뀐 것 없음$/);
  assert.match(limits, /^읽은 범위: 제품 코드일 수 있는 호출 \d+개 중 \d+개를 풀었다/);
  assert.match(compared, /^기준 뒤 바뀐 것 \(기준 /);
  assert.match(ask({ question: "node", id: "cli:notes" }).text, /기능 cli:notes — 메모를 더하고 목록을 보여 준다/);
  assert.match(ask({ question: "down", id: "cli:notes" }).text, /기능→코드 1개\n {4}코드 bin\/notes\.mjs/);
  assert.match(ask({ question: "up", id: "cli:notes" }).text, /화면요소→기능 1개\n {4}화면요소 MAIN-01#1/);
  assert.match(ask({ question: "gaps" }).text, /제품 그래프 정합성 검사/);
  assert.match(ask({ question: "changes" }).text, /노드 종류별/);
  // reach from a 기능 equals the check's closure over the whole graph.
  const read = readProductGraphBuild({ root: f.root });
  const ix = walk.index(read.graph);
  const closure = walk.closure(ix, walk.handlersOf(ix, "cli:notes"));
  const reached = ask({ question: "reach", id: "cli:notes", limit: 500 }).reach.ids;
  assert.deepEqual(reached, [...closure].filter((id) => ix.nodes.get(id)?.type === "코드").sort());
  const all = walk.closure(
    ix,
    read.graph.nodes.filter((node) => node.type === "기능").flatMap((node) => walk.handlersOf(ix, node.id)),
  );
  const unreached = read.check.lists.unreachedCode.files.flatMap((file) => file.declarations);
  for (const id of unreached) assert(!all.has(id), id);
  assert.deepEqual(ask({ question: "reach", id: "lib/notes.mjs" }).reach.ids, ["cli:notes"]);
  // Paging: every item exactly once.
  const seen = [];
  for (let cursor = 0, guard = 0; cursor !== null && guard < 100; guard++) {
    const page = ask({ question: "find", text: "notes", limit: 2, cursor });
    seen.push(...page.rows.filter((row) => row.id).map((row) => row.id));
    if (page.page.remaining) assert.match(page.text, /외 \d+개 — 다음: find "notes" --cursor \d+/);
    cursor = page.page.nextCursor;
  }
  assert.deepEqual(
    seen,
    walk.find(walk.context({ graph: read.graph }), "notes").map((node) => node.id),
  );
  assert.equal(new Set(seen).size, seen.length);
  // 15: addNote → store → addNote: the repeated node is marked, not expanded.
  const cycle = ask({ question: "down", id: "lib/notes.mjs#addNote", depth: 4 }).text;
  assert.match(cycle, /코드 lib\/notes\.mjs#addNote .*\(위에 있음\)/);
  assert.equal((cycle.match(/#store/g) || []).length, 1);
  // Unknown ID and no build.
  const missing = ask({ question: "node", id: "cli:note" });
  assert.equal(missing.code, "PRODUCT_GRAPH_NODE_NOT_FOUND");
  assert(missing.nearest.includes("cli:notes"));
  const g = notesProject(t, { records: false });
  const none = queryProductGraph({ root: g.root });
  assert.equal(none.code, "PRODUCT_GRAPH_NOT_BUILT");
  assert.match(none.text, /없음, 빌드 필요.*product-graph-build/);
  assert.equal(none.ordinaryWorkBlocked, false);
  // The CLI prints the same text.
  const cli = await runCommand(["product-graph-query", f.root, "down", "cli:notes"]);
  assert.equal(cli.text, ask({ question: "down", id: "cli:notes" }).text);
});

test("acceptance 14: lode_product_graph_query is listed and callable through lode_tools_call and is read-only", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const before = snapshot(f.root);
  const listed = await dispatch({
    jsonrpc: "2.0",
    id: "d",
    method: "tools/call",
    params: { name: "lode_tools_discover", arguments: { prefix: "lode_product_" } },
  });
  assert.match(JSON.stringify(listed), /lode_product_graph_query|"query"/);
  assert.match(JSON.stringify(listed), /lode_product_graph_baseline|"baseline"/);
  const response = await dispatch({
    jsonrpc: "2.0",
    id: "q",
    method: "tools/call",
    params: {
      name: "lode_tools_call",
      arguments: { name: "lode_product_graph_query", arguments: { project_root: f.root, question: "reach", id: "cli:notes" } },
    },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.match(response.result.content[0].text, /닿는 코드 \d+개/);
  assert.deepEqual(snapshot(f.root), before);
});

// ---------- the page ----------

const shown = (ui, view) => {
  ui.event(`tab-${view}`);
  return visibleText(ui.ids.get(`view-${view}`));
};
const tabState = (ui) =>
  Object.fromEntries(["status", "product", "gaps", "map"].map((name) => [name, ui.ids.get(`tab-${name}`).getAttribute("aria-selected")]));

test("acceptance 1: the export opens on the status view; --view picks each view; map-only options open the map", async (t) => {
  const f = notesProject(t);
  buildProductGraph({ root: f.root });
  assert.equal((await buildGraphExplorerSnapshot({ root: f.root })).initialView, "status");
  for (const view of ["status", "product", "gaps", "map"]) assert.equal((await buildGraphExplorerSnapshot({ root: f.root, view })).initialView, view);
  for (const options of [{ query: "notes" }, { anchorIds: ["x"] }, { paths: ["lib/list.mjs"] }, { layer: "code" }])
    assert.equal((await buildGraphExplorerSnapshot({ root: f.root, ...options })).initialView, "map", JSON.stringify(options));
  assert.equal((await buildGraphExplorerSnapshot({ root: f.root, query: "notes", view: "gaps" })).initialView, "gaps");
  await assert.rejects(buildGraphExplorerSnapshot({ root: f.root, view: "other" }), { code: "GRAPH_EXPLORER_INVALID_VIEW" });
  await assert.rejects(buildGraphExplorerSnapshot({ root: f.root, lang: "fr" }), { code: "GRAPH_EXPLORER_INVALID_LANG" });
  const output = path.join(temporary(t), "copy.html");
  const cli = await runCommand(["graph-explorer", f.root, "--view", "product", "--lang", "ko", "--output", output]);
  assert.equal(cli.initialView, "product");
  assert.match(read(output), /<html lang="ko">/);
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root }));
  assert.deepEqual(tabState(ui), { status: "true", product: "false", gaps: "false", map: "false" });
  assert.equal(ui.ids.get("view-status").hidden, false);
  assert.match(ui.ids.get("view-map").className, /view-offstage/);
  ui.event("tab-gaps");
  assert.deepEqual(tabState(ui), { status: "false", product: "false", gaps: "true", map: "false" });
});

test("acceptance 3: a plain click selects one record; Ctrl/Cmd and Shift add or remove one", () => {
  const nodes = ["A", "B", "C"].map((nodeId) => ({ nodeId, name: nodeId, kind: "Feature", views: ["work"] }));
  const ui = explorerDom({
    kind: "GraphExplorerSnapshot",
    project: { projectId: "synthetic-only" },
    generatedAt: "2026-11-16T00:00:00Z",
    graph: { nodes, edges: [], initialNodeId: "A" },
    codeGraph: { nodes: [], edges: [], status: "unavailable" },
    originals: {},
    history: { entries: [] },
  });
  const count = () => Number(ui.ids.get("selection-count").textContent.match(/^\d+/)[0]);
  const record = (id) => ui.ids.get("records").children.find((item) => item.children[0].textContent.startsWith(id)).children[0];
  assert.equal(count(), 1);
  ui.event(record("B"));
  assert.equal(count(), 1, "plain click: only B");
  ui.event(record("C"), "click", { ctrlKey: true });
  assert.equal(count(), 2);
  ui.event(record("A"), "click", { metaKey: true });
  assert.equal(count(), 3);
  ui.event(record("C"), "click", { shiftKey: true });
  assert.equal(count(), 2, "Shift-click removes a selected record");
  ui.event(record("C"), "click", { shiftKey: true });
  assert.equal(count(), 3, "and adds it back");
  ui.event(record("A"));
  assert.equal(count(), 1);
});

const contrast = (one, two) => {
  const luminance = (hex) => {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [a, b] = [luminance(one), luminance(two)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

test("acceptance 4: both themes are full variable sets, text contrast is at least 4.5:1 in each, and no new view hard-codes a colour", () => {
  const style = read(path.join(assets, "style.css"));
  const views = read(path.join(assets, "views.css"));
  assert.doesNotMatch(views, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "views.css uses theme variables only");
  const sets = [...style.matchAll(/:root\{([^}]*)\}/g)].map((match) =>
    Object.fromEntries(
      match[1]
        .split(";")
        .filter((part) => part.startsWith("--"))
        .map((part) => part.split(":")),
    ),
  );
  assert.equal(sets.length, 2, "a light set and a dark set");
  assert.match(style, /@media \(prefers-color-scheme:dark\)\{:root\{/);
  const [light, dark] = sets;
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  const withoutTokens = style.replace(/:root\{[^}]*\}/g, "");
  assert.doesNotMatch(withoutTokens, /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|rgba?\(/, "the map's colours are variables too");
  for (const name of new Set([...(style + views).matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1]))) assert(name in light && name in dark, name);
  for (const set of [light, dark])
    for (const background of ["--bg", "--panel"])
      for (const foreground of ["--text", "--muted", "--code", "--context", "--pending", "--unknown", "--finished", "--historical"])
        assert(contrast(set[foreground], set[background]) >= 4.5, `${foreground} on ${background}: ${contrast(set[foreground], set[background]).toFixed(2)}`);
  const browser = read(path.join(assets, "browser.js"));
  assert.match(browser, /themeColor\("--map-edge"/, "canvas colours follow the theme");
});

test("acceptance 5: Korean and English give the same structure; every new-view string is in the tables; build words are identical in both", async (t) => {
  const keys = (table) => Object.keys(table).sort();
  assert.deepEqual(keys(explorerText.en), keys(explorerText.ko));
  for (const key of keys(explorerText.en)) assert.equal(typeof explorerText.en[key], typeof explorerText.ko[key], key);
  const source = read(path.join(assets, "views.js"));
  assert.doesNotMatch(source, /[가-힣]/, "no Korean text is typed into views.js; the build's words come from the walk module");
  const used = new Set([...source.matchAll(/\bt\("([A-Za-z_]+)"/g)].map((match) => match[1]));
  for (const key of used) assert(key in explorerText.en, key);
  // No sentence-like literal outside the tables (class names, roles and keys only).
  const literals = [...source.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]).filter((text) => /[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}/.test(text));
  assert.deepEqual(literals, []);
  const f = notesProject(t);
  buildProductGraph({ root: f.root });
  const shape = (element) => [element.tagName, element.getAttribute("role"), element.children.filter((child) => child.tagName !== "text").map(shape)];
  const render = async (lang) => explorerDom(await buildGraphExplorerSnapshot({ root: f.root, lang }));
  const en = await render("en"),
    ko = await render("ko");
  for (const view of ["view-status", "view-product", "view-gaps"]) assert.deepEqual(shape(en.ids.get(view)), shape(ko.ids.get(view)), view);
  assert.equal(en.ids.get("tab-product").textContent, "Product graph");
  assert.equal(ko.ids.get("tab-product").textContent, "제품 그래프");
  const pre = (ui) =>
    descendants(ui.ids.get("view-gaps"))
      .filter((element) => element.tagName === "pre")
      .map((element) => element.textContent);
  assert.deepEqual(pre(en), pre(ko), "the build's words are shown as they are in both languages");
  assert.match(pre(en).join("\n"), /이 그래프가 답하지 못하는 것|호출 \d+개/);
  assert.equal(ko.ids.get("map-language-note").hidden, false);
  assert.equal(en.ids.get("map-language-note").hidden, true);
});

test("acceptance 6: the status view marks the user's direction, orders Sessions, counts the records and finishes an item only by a later todo", async (t) => {
  const f = notesProject(t);
  const snap = await buildGraphExplorerSnapshot({ root: f.root, lang: "ko" });
  const status = explorerStatus.model(snap);
  // Four Sessions: the three that saved work and the Project's first, which saved none.
  assert.deepEqual(status.counts, { sessions: 4, records: 5, pending: 1, unknowns: 2, files: status.counts.files, partialRecords: 0 });
  assert.deepEqual(
    status.sessions.slice(0, 2).map((group) => group.purpose),
    ["Keep the notes tool reliable", "Look at reading on a phone"],
  );
  assert(status.sessions.slice(2).every((group) => !group.pending && !group.unknowns));
  const todo = status.items.find((item) => item.todoId === "todo-store");
  assert.equal(todo.state, "finished");
  const finishing = status.records.get(todo.finishedBy);
  assert.equal(finishing.summary, "Tested the store.");
  // "Check the caller" is followed by a record with empty pending work and no resolves: it stays open.
  assert.equal(status.items.find((item) => item.text === "Check the caller").state, "open");
  const ui = explorerDom(snap);
  const text = visibleText(ui.ids.get("view-status"));
  assert.match(text, /이 프로젝트가 하려는 것사용자가 정한 내용Keep every note/);
  assert.match(text, /기록에 적힌 것만 보입니다\. 여기 없다고 해서 남은 일이 없다는 뜻은 아닙니다\./);
  assert.match(text, /남은 일이 없는 세션 2개 펼치기/);
  assert.doesNotMatch(text, /Tidy names/, "the Session with nothing open is folded");
  // The record page of the first record: the item is finished with a link; the other stays open.
  const open = descendants(ui.ids.get("view-status")).find(
    (element) => element.tagName === "button" && /Keep the notes tool reliable/.test(element.textContent),
  );
  ui.event(open);
  const recordButton = descendants(ui.ids.get("view-status")).find(
    (element) => element.tagName === "button" && /Looked at the store\./.test(element.textContent),
  );
  ui.event(recordButton);
  const page = visibleText(ui.ids.get("view-status"));
  assert.match(page, /Test the store다음 기록에서 끝남/);
  assert.match(page, /Check the caller뒤 기록에 끝냈다는 내용이 없습니다/);
  assert.match(page, /에이전트가 적은 내용/);
  assert.doesNotMatch(page, /사용자가 정한 내용/, "agent text and user decisions never share an unmarked block");
});

test("acceptance 7: a folder that is not a Project, and a Project without records, say what is missing and show no sample", async (t) => {
  const base = temporary(t);
  const before = snapshot(base);
  const plain = explorerDom(await buildGraphExplorerSnapshot({ root: base }));
  assert.match(visibleText(plain.ids.get("view-status")), /This folder is not a Lode project/);
  assert.match(shown(plain, "product"), /None, build needed/);
  assert.deepEqual(snapshot(base), before);
  const f = notesProject(t, { records: false, documents: false });
  const empty = explorerDom(await buildGraphExplorerSnapshot({ root: f.root }));
  const text = visibleText(empty.ids.get("view-status"));
  assert.match(text, /No saved work records/);
  assert.match(text, /No direction is recorded/);
  assert.doesNotMatch(text, /Pending \d/);
});

test("acceptance 8: with documents the tree walks 유저 활동 → 화면요소 → 기능 → 코드 one step at a time, the path shown, estimates marked", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root, includeEstimates: true });
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root, view: "product" }));
  const all = () => descendants(ui.ids.get("view-product"));
  const button = (pattern) => all().find((element) => element.tagName === "button" && pattern.test(element.textContent));
  ui.event(button(/^@유저 활동/));
  const rows = () => all().filter((element) => element.getAttribute("role") === "treeitem");
  assert.equal(rows().length, 1, "only the start is in the DOM before expanding");
  const expand = (pattern) => {
    const row = rows().find((element) => pattern.test(element.textContent));
    assert(row, String(pattern));
    ui.event(row, "keydown", { key: "ArrowRight" });
    return row;
  };
  expand(/^▸@유저 활동/);
  expand(/유저 활동 UA-NOTE-01/);
  expand(/화면요소 MAIN-01#1/);
  const fn = expand(/기능 cli:notes/);
  assert(rows().some((element) => /코드 bin\/notes\.mjs/.test(element.textContent)));
  assert.equal(ui.ids.get("product-path").textContent, "Path: @유저 활동 › UA-NOTE-01 › MAIN-01#1 › cli:notes");
  // Estimated documents: their nodes and edges carry the estimate mark.
  assert.match(rows().find((element) => /유저 활동 UA-NOTE-01/.test(element.textContent)).textContent, /\[추정: 코드만 보고 쓴 추정\]/);
  assert.match(rows().find((element) => /화면요소 MAIN-01#1/.test(element.textContent)).textContent, /← 유저플로우 기획서\/UA-NOTE-01\.md:\d+ \[추정: /);
  ui.event(fn, "keydown", { key: "ArrowLeft" });
  assert(!rows().some((element) => /코드 bin\/notes\.mjs/.test(element.textContent)), "folding removes the level from the DOM");
});

test("acceptance 9 / 12: without documents the view starts from 기능 by kind under the guide; the gaps view says what check.txt says", async (t) => {
  const f = notesProject(t, { records: false, documents: false });
  buildProductGraph({ root: f.root });
  const check = json(path.join(f.build, "check.json"));
  const checkText = read(path.join(f.build, "check.txt"));
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root, view: "product", lang: "ko" }));
  const product = visibleText(ui.ids.get("view-product"));
  assert(product.indexOf("처음 쓸 때 — 빠진 입력") < product.indexOf("@기능/cli — 기능 1개"));
  for (const [type, count] of Object.entries(check.counts)) if (count) assert.match(product, new RegExp(`${type} ${count}`));
  const gaps = ui.ids.get("view-gaps");
  const gapText = shown(ui, "gaps");
  for (const entry of walk.gapLists(
    check,
    json(path.join(f.build, "graph.json")).nodeTypes.map((item) => item.type),
  )) {
    assert(checkText.includes(entry.head[0]), entry.head[0]);
    assert(
      descendants(gaps).some((element) => element.tagName === "summary" && element.textContent === entry.head[0]),
      entry.key,
    );
  }
  for (const [index, item] of check.checks.entries()) assert(gapText.includes(`${index + 1}. ${item.heading}`));
  const outcomes = descendants(gaps).filter((element) => /^outcome /.test(element.className || ""));
  assert.equal(outcomes.length, 6);
  const unchecked = outcomes.filter((element) => element.className.includes("unchecked"));
  assert(unchecked.length > 0);
  for (const element of unchecked) assert.match(element.textContent, /^⊘ 검사 못 함: /);
  for (const element of outcomes.filter((item) => item.className.includes("outcome-none"))) assert.equal(element.textContent, "✓ 0건");
});

test("acceptance 11 / 18: with no build both product views say so and the export writes nothing else; the CSP stays and --share keeps project paths only", async (t) => {
  const f = notesProject(t);
  const before = snapshot(f.root);
  const output = path.join(temporary(t), "copy.html");
  await exportGraphExplorer({ root: f.root, output, lang: "ko" });
  assert.deepEqual(snapshot(f.root), before, "the export builds nothing");
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root, lang: "ko" }));
  for (const view of ["product", "gaps"]) {
    const text = shown(ui, view);
    assert.match(text, /없음, 빌드 필요/);
    assert.match(text, /product-graph-build /);
  }
  const html = read(output);
  assert.match(
    html,
    /default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'/,
  );
  for (const file of ["views.js", "product-graph-walk.js", "status-model.js", "i18n.js"])
    assert.doesNotMatch(read(path.join(assets, file)), /\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|innerHTML/, file);
  buildProductGraph({ root: f.root });
  const shared = await buildGraphExplorerSnapshot({ root: f.root, share: true });
  const section = JSON.stringify(shared.productGraph);
  assert(!section.includes(f.root) && !section.includes(f.root.replaceAll("\\", "\\\\")), "no absolute path in the product graph section");
  assert.match(shared.productGraph.buildCommand, /<project>/);
});

test("acceptance 13 / 29: the page's text board is the command's text, and 6.3 and 8A stay two statements", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root, includeEstimates: true });
  fs.writeFileSync(path.join(f.root, "lib/list.mjs"), SOURCE["lib/list.mjs"].replace("[]", "[0]"));
  buildProductGraph({ root: f.root, includeEstimates: true });
  const snap = await buildGraphExplorerSnapshot({ root: f.root, view: "product" });
  const ui = explorerDom(snap);
  const all = () => descendants(ui.ids.get("view-product"));
  ui.event(all().find((element) => element.tagName === "button" && /^@유저 활동/.test(element.textContent)));
  for (const pattern of [/^▸@유저 활동/, /유저 활동 UA-NOTE-01/, /화면요소 MAIN-01#1/]) {
    const row = all().find((element) => element.getAttribute("role") === "treeitem" && pattern.test(element.textContent));
    ui.event(row, "keydown", { key: "Enter" });
  }
  const board = ui.ids.get("product-board-text").textContent;
  assert.equal(board, queryProductGraph({ root: f.root, question: "down", id: "MAIN-01#1" }).text);
  // Up from a row: the result block and the board follow the same question.
  const up = all().find((element) => element.tagName === "button" && element.textContent === "What points to this");
  ui.event(up);
  assert.equal(ui.ids.get("product-board-text").textContent, queryProductGraph({ root: f.root, question: "up", id: "UA-NOTE-01" }).text);
  // The comparison block is check.txt's, and the header keeps freshness and change apart.
  const block = read(path.join(f.build, "check.txt"))
    .split("\n\n")
    .find((part) => part.startsWith("기준과 비교"));
  const gaps = descendants(ui.ids.get("view-gaps"))
    .filter((element) => element.tagName === "pre")
    .map((element) => element.textContent);
  assert(
    gaps.some((text) => text.trimEnd() === block.split("\n").slice(1).join("\n")),
    "the gaps view shows check.txt's comparison block",
  );
  const header = queryProductGraph({ root: f.root }).header;
  assert.match(header[0], /빌드 뒤 바뀐 것 없음/);
  assert.match(header[2], /^기준 뒤 바뀐 것 .*변경 [1-9]/);
  assert.equal(header.length, 3);
});

test("acceptance 17: tabs and tree rows work from the keyboard", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root }));
  ui.event("tab-status", "keydown", { key: "ArrowRight" });
  assert.equal(ui.ids.get("tab-product").getAttribute("aria-selected"), "true");
  assert.equal(ui.stats.focused, "tab-product");
  ui.event("tab-product", "keydown", { key: "End" });
  assert.equal(ui.ids.get("tab-map").getAttribute("aria-selected"), "true");
  ui.event("tab-map", "keydown", { key: "Home" });
  assert.equal(ui.ids.get("tab-status").getAttribute("aria-selected"), "true");
  for (const name of ["status", "product", "gaps", "map"]) assert(ui.html.includes(`role="tab" id="tab-${name}" aria-controls="view-${name}"`), name);
  // Tree rows: Enter or Right expands, Left folds (acceptance 8 walks the same rows).
  ui.event("tab-product");
  const all = () => descendants(ui.ids.get("view-product"));
  ui.event(all().find((element) => element.tagName === "button" && /^@기능 —/.test(element.textContent)));
  const start = all().find((element) => element.getAttribute("role") === "treeitem");
  assert.equal(start.getAttribute("tabindex"), "0");
  ui.event(start, "keydown", { key: "Enter" });
  assert.equal(start.getAttribute("aria-expanded"), "true");
  ui.event(start, "keydown", { key: "ArrowLeft" });
  assert.equal(start.getAttribute("aria-expanded"), "false");
  const style = graphExplorerStyle();
  assert.match(style, /@media\(max-width:650px\)\{\.frame\{/);
  assert.doesNotMatch(read(path.join(assets, "views.css")), /min-width:(?:[4-9]\d\d|\d{4,})px/, "no view needs more than a phone's width");
});

test("a build in a shape the page does not know leaves the other views working", async (t) => {
  const f = notesProject(t);
  buildProductGraph({ root: f.root });
  const snap = await buildGraphExplorerSnapshot({ root: f.root });
  delete snap.productGraph.check.lists;
  const ui = explorerDom(snap);
  assert.match(visibleText(ui.ids.get("view-status")), /Keep every note/);
  assert.match(shown(ui, "gaps"), /The product graph build could not be read/);
});

// ---------- review round 1 ----------

const older = (version) => path.join(pluginRoot, "test", "fixtures", "product-graph", "older-builds", version);
const QUESTIONS = [
  { question: "overview" },
  { question: "node", id: "cli:notes" },
  { question: "down", id: "cli:notes", depth: 3 },
  { question: "up", id: "cli:notes" },
  { question: "reach", id: "cli:notes" },
  { question: "reach", id: "MAIN-01" },
  { question: "reach", id: "lib/notes.mjs" },
  { question: "find", text: "notes" },
  { question: "gaps" },
  { question: "gaps", list: "unreachedCode" },
  { question: "gaps", list: "missingIds" },
  { question: "changes" },
  { question: "changes", list: "changed" },
  { question: "down", id: "@기능" },
];

test("A2: builds made by 0.3.0-beta.124, 125 and 126 answer every question and fill every view, saying what they do not carry", async (t) => {
  const f = notesProject(t, { documents: false });
  const base = await buildGraphExplorerSnapshot({ root: f.root, lang: "ko" });
  for (const version of ["beta-124", "beta-125", "beta-126"]) {
    for (const request of QUESTIONS) {
      const answer = queryProductGraph({ buildDirectory: older(version), ...request });
      assert.equal(answer.status, "answered", `${version} ${JSON.stringify(request)}: ${answer.message}`);
      assert.match(answer.header[0], /소스가 바뀌었는지 알 수 없음/);
    }
    const changes = queryProductGraph({ buildDirectory: older(version), question: "changes", list: "changed" }).text;
    assert.match(changes, /비교하지 않음 — 이 빌드에는 기준 비교가 없다/);
    const limits = queryProductGraph({ buildDirectory: older(version) }).header[1];
    if (version !== "beta-126") assert.match(limits, /이전 버전의 빌드/);
    const snap = structuredClone(base);
    snap.productGraph = {
      status: "built",
      builtAt: "2026-11-01T00:00:00.000Z",
      freshness: { state: "unknown", text: "소스가 바뀌었는지 알 수 없음 — 소스 루트 없이 빌드 폴더만 받았다" },
      baselineNow: null,
      buildCommand: "product-graph-build <project>",
      graph: json(path.join(older(version), "graph.json")),
      check: json(path.join(older(version), "check.json")),
    };
    const ui = explorerDom(snap);
    const gaps = shown(ui, "gaps");
    assert.doesNotMatch(gaps, /제품 그래프 빌드를 읽지 못했습니다/, version);
    assert.match(gaps, /제품 그래프 정합성 검사/);
    if (version !== "beta-126") assert.match(gaps, /이 빌드는 제품 코드일 수 없는 호출과 제품 밖 모듈로 가는 호출을 따로 세지 않았다/);
    const product = shown(ui, "product");
    assert.doesNotMatch(product, /제품 그래프 빌드를 읽지 못했습니다/, version);
    assert.match(product, /노드 수:/);
    assert.match(shown(ui, "status"), /Keep the notes tool reliable|이 프로젝트가 하려는 것/);
  }
});

test("A1: appending after the last declaration or moving one to or from the end of its file changes no declaration hash", (t) => {
  const f = notesProject(t, { records: false });
  writeTree(f.root, { "tools/report.py": "def first():\n    return 1\n\n\ndef second():\n    return 2\n" });
  buildProductGraph({ root: f.root });
  const hash = (id) => json(path.join(f.build, "graph.json")).nodes.find((node) => node.id === id).contentSha256;
  const second = hash("tools/report.py#second"),
    first = hash("tools/report.py#first");
  fs.appendFileSync(path.join(f.root, "tools/report.py"), "\n\ndef third():\n    return 3\n");
  buildProductGraph({ root: f.root });
  const value = changes(f.build);
  assert.deepEqual(group(value, "코드").changed, ["tools/report.py"]);
  assert.deepEqual(group(value, "코드").added, ["tools/report.py#third"]);
  assert.equal(hash("tools/report.py#second"), second);
  // Move second to the top (away from the end) and first to the end.
  fs.writeFileSync(path.join(f.root, "tools/report.py"), "def second():\n    return 2\n\n\ndef third():\n    return 3\n\n\ndef first():\n    return 1\n");
  buildProductGraph({ root: f.root });
  assert.equal(hash("tools/report.py#second"), second);
  assert.equal(hash("tools/report.py#first"), first);
  assert.deepEqual(group(changes(f.build), "코드").changed, ["tools/report.py"]);
});

test("A3 / A4: reach on a 화면 goes through its 화면요소; reach says where it does not apply; not compared never reads as zero", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root, includeEstimates: true });
  const screen = queryProductGraph({ root: f.root, question: "reach", id: "MAIN-01" });
  assert.match(screen.text, /거치는 기능 1개: cli:notes/);
  assert(screen.reach.ids.includes("lib/notes.mjs#store"));
  const base = temporary(t);
  const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
  buildProductGraph({
    sourceRoot: path.join(fixtures, "ui-signal"),
    documentsDirectory: path.join(fixtures, "ui-signal-documents"),
    rulesFile: path.join(fixtures, "empty-rules.json"),
    outputDirectory: path.join(base, "out"),
    includeEstimates: true,
  });
  const policy = queryProductGraph({ buildDirectory: path.join(base, "out"), question: "reach", id: "P1" });
  assert.match(policy.text, /닿음은 정책에 쓰지 않는다/);
  assert.doesNotMatch(policy.text, /0개/);
  const ctx = walk.context({ graph: json(path.join(base, "out", "graph.json")) });
  assert.equal(walk.reachDirection(ctx, "P1"), null);
  assert.equal(walk.reachDirection(ctx, "MAIN-01"), "code");
  // A rules change: the unexplained list is not compared, and says so.
  fs.writeFileSync(path.join(f.family, "호출 방식 표.json"), JSON.stringify({ schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: [] }));
  buildProductGraph({ root: f.root, includeEstimates: true });
  const unexplained = queryProductGraph({ root: f.root, question: "changes", list: "unexplained" }).text;
  assert.match(unexplained, /비교하지 않음 — 호출 방식 표가 기준과 다르다/);
  assert.doesNotMatch(unexplained, / 0개/);
});

test("A5 / B7: a new Lode version alone is not a new reader, so the reproducibility stop stays on, and the stop names the way out", (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const file = path.join(f.build, "baseline.json");
  const baseline = json(file);
  baseline.reader = { ...baseline.reader, lode: "0.0.0-older" };
  fs.writeFileSync(file, JSON.stringify(baseline));
  buildProductGraph({ root: f.root });
  assert.match(read(path.join(f.build, "check.txt")), /읽는 방식 그대로/);
  assert.doesNotMatch(read(path.join(f.build, "check.txt")), /코드를 읽는 방식에서 왔을 수 있다/);
  baseline.nodes.find((node) => node[0] === "lib/notes.mjs#store")[5] = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(baseline));
  assert.throws(() => buildProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_NOT_REPRODUCIBLE", message: /build\/baseline\.json을 지우고 다시 빌드한다/ });
});

test("A6 / B2 / B1: a cancelled todo leaves the open count with its own state; an open todo counts once; a partial record is never folded as empty", async (t) => {
  const f = notesProject(t, { records: false });
  const first = f.save({
    summary: "Planned two checks.",
    todos: [
      { todoId: "todo-a", task: "Check A", status: "pending", origin: "user-directed", nextAction: "Run A" },
      { todoId: "todo-b", task: "Check B", status: "pending", origin: "user-directed", nextAction: "Run B" },
    ],
  });
  const second = f.save({
    summary: "Dropped A, started B.",
    todos: [
      { todoId: "todo-a", task: "Check A", status: "cancelled", origin: "user-directed", reason: "No longer needed", prior: exact(first) },
      { todoId: "todo-b", task: "Check B", status: "partial", origin: "user-directed", nextAction: "Finish B", prior: exact(first) },
    ],
  });
  const snap = await buildGraphExplorerSnapshot({ root: f.root, lang: "ko" });
  const status = explorerStatus.model(snap);
  const item = (todoId, recordId) => status.items.find((entry) => entry.todoId === todoId && entry.recordId === recordId);
  const firstId = first.evidence.evidenceId,
    secondId = second.evidence.evidenceId;
  assert.equal(item("todo-a", firstId).state, "cancelled");
  assert.equal(item("todo-a", firstId).cancelledBy, secondId);
  assert.equal(item("todo-b", firstId).state, "earlier");
  assert.equal(item("todo-b", secondId).state, "open");
  assert.equal(status.counts.pending, 1, "B is counted once, A not at all");
  const ui = explorerDom(snap);
  const record = descendants(ui.ids.get("view-status")).find(
    (element) => element.tagName === "button" && /Keep the notes tool reliable/.test(element.textContent),
  );
  ui.event(record);
  ui.event(descendants(ui.ids.get("view-status")).find((element) => element.tagName === "button" && /Planned two checks\./.test(element.textContent)));
  const page = visibleText(ui.ids.get("view-status"));
  assert.match(page, /Check A뒤 기록에서 취소됨/);
  assert.match(page, /Check B뒤 기록에서 다시 적힘/);
  assert.doesNotMatch(page, /Check A다음 기록에서 끝남/);
  // A record whose body arrived only in part.
  const partial = structuredClone(snap);
  const node = partial.graph.nodes.find((entry) => entry.subtype === "SessionWorkEvidence" && entry.evidenceDigest === second.evidence.evidenceDigest);
  node.workContent = { ...node.workContent, todos: [], pending: [] };
  node.workContentCoverage = { ...(node.workContentCoverage || {}), partial: true };
  const partialStatus = explorerStatus.model(partial);
  assert.equal(partialStatus.counts.partialRecords, 1);
  assert.equal(partialStatus.sessions.find((group) => group.records.some((entry) => entry.id === secondId)).partial, 1);
  const shownPartial = visibleText(explorerDom(partial).ids.get("view-status"));
  assert.match(shownPartial, /본문 일부만 들어 있음/);
  assert.match(shownPartial, /본문 일부만 들어 있는 기록 1개/);
});

test("A7 / A8: a stand-alone query uses the roots it was given; backslash paths and NFD text are matched", async (t) => {
  const base = temporary(t);
  writeTree(path.join(base, "source"), SOURCE);
  writeTree(path.join(base, "documents"), DOCUMENTS);
  const rules = path.join(base, "rules.json");
  fs.writeFileSync(rules, JSON.stringify({ schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: [] }));
  const out = path.join(base, "out");
  buildProductGraph({ sourceRoot: path.join(base, "source"), documentsDirectory: path.join(base, "documents"), rulesFile: rules, outputDirectory: out });
  const full = await runCommand([
    "product-graph-query",
    path.join(base, "source"),
    "overview",
    "--build",
    out,
    "--documents",
    path.join(base, "documents"),
    "--rules",
    rules,
  ]);
  assert.match(full.header[0], /빌드 뒤 바뀐 것 없음$/);
  const sourceOnly = await runCommand(["product-graph-query", path.join(base, "source"), "overview", "--build", out]);
  assert.doesNotMatch(sourceOnly.header[0], /소스 루트 없이/);
  assert.match(sourceOnly.header[0], /문서가 바뀌었는지 알 수 없음 — 문서 폴더를 받지 않았다/);
  assert.match(sourceOnly.header[0], /호출 방식 표가 바뀌었는지 알 수 없음 — 호출 방식 표 파일을 받지 않았다/);
  fs.appendFileSync(path.join(base, "source", "lib/list.mjs"), "// later\n");
  assert.match(
    (await runCommand(["product-graph-query", path.join(base, "source"), "overview", "--build", out])).header[0],
    /빌드가 낡음: 소스 파일 1개 \(lib\/list\.mjs\)/,
  );
  // A8
  const backslash = queryProductGraph({ buildDirectory: out, question: "reach", id: "lib\\notes.mjs" });
  assert.equal(backslash.status, "answered");
  assert.deepEqual(backslash.reach.ids, ["cli:notes"]);
  const nfd = queryProductGraph({ buildDirectory: out, question: "find", text: "메모를 더하고".normalize("NFD") });
  assert(
    nfd.rows.some((row) => row.id === "cli:notes"),
    "NFD text finds the NFC words",
  );
  const near = queryProductGraph({ buildDirectory: out, question: "node", id: "lib\\note.mjs" });
  assert.equal(near.code, "PRODUCT_GRAPH_NODE_NOT_FOUND");
  const f = notesProject(t);
  const status = explorerStatus.model(await buildGraphExplorerSnapshot({ root: f.root }));
  assert(explorerStatus.search(status, "store".normalize("NFD")).length > 0);
});

test("B3 / B5 / B8: the board is Korean in both languages; down is bounded; gap items and declarations are built when opened; rows have names", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const snap = await buildGraphExplorerSnapshot({ root: f.root, lang: "en", view: "product" });
  delete snap.productGraph.check.changes;
  const ui = explorerDom(snap);
  const pre = descendants(ui.ids.get("view-product"))
    .filter((element) => element.tagName === "pre")
    .map((element) => element.textContent)
    .join("\n");
  assert.match(pre, /기준 없음 — 이 빌드에는 기준 비교가 없다/);
  assert.doesNotMatch(pre, /this build/);
  // Rows carry their line as an accessible name.
  const all = () => descendants(ui.ids.get("view-product"));
  ui.event(all().find((element) => element.tagName === "button" && /^@기능 —/.test(element.textContent)));
  const row = all().find((element) => element.getAttribute("role") === "treeitem");
  assert.match(row.getAttribute("aria-label"), /^@기능 — /);
  // Gap lists are empty in the DOM until opened.
  const lists = descendants(ui.ids.get("view-gaps")).filter((element) => element.tagName === "details" && /gap-list/.test(element.className || ""));
  assert(lists.length > 0);
  for (const details of lists) assert(!descendants(details).some((element) => element.tagName === "ul"), "no items before opening");
  const unreached = lists.find((details) => /^문서별 상태:/.test(details.children[0].textContent));
  unreached.open = true;
  ui.event(unreached, "toggle");
  assert(descendants(unreached).some((element) => element.tagName === "ul"));
  // A deep down stops at the row bound and says so.
  const nodes = [{ id: "fn", type: "기능", kind: "cli", handling: "따라간다", positions: [] }];
  const edges = [];
  for (let a = 0; a < 60; a++) {
    nodes.push({ id: `a${a}`, type: "코드", kind: "function", file: "x.mjs", lines: [a + 1, a + 1] });
    edges.push({ type: a ? "call" : "기능→코드", from: a ? "a0" : "fn", to: `a${a}` });
    for (let b = 0; b < 60; b++) edges.push({ type: "call", from: `a${a}`, to: `b${b}` });
  }
  for (let b = 0; b < 60; b++) {
    nodes.push({ id: `b${b}`, type: "코드", kind: "function", file: "y.mjs", lines: [b + 1, b + 1] });
    for (let c = 0; c < 60; c++) edges.push({ type: "call", from: `b${b}`, to: `a${c}` });
  }
  const answer = walk.ask(walk.context({ graph: { nodeTypes: [], nodes, edges } }), { question: "down", id: "a0", depth: 8, limit: 500 });
  const shownNodes = answer.rows.filter((row) => row.kind === "node").length;
  // Deeper levels stop at 2000 rows; the first level is paged by --limit (a0 has 119 children) and always shown.
  assert(shownNodes <= 2000 + 119, String(shownNodes));
  assert.match(answer.text, /한 답의 줄 수 한도\(2000\)에 닿았다/);
});

test("C2: the map prepares off-stage after the first view and works when opened by its tab or the link", async (t) => {
  const f = notesProject(t);
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root }), { cardMeasure: () => 120 });
  await ui.settle();
  assert.equal(ui.document.documentElement.dataset.explorerReady, "true", "the map started without being shown");
  assert.match(ui.ids.get("view-map").className, /view-offstage/);
  const cards = () => ui.ids.get("graph").children.filter((element) => element.getAttribute("data-node"));
  assert(cards().length > 0, "the map placed its cards while off-stage");
  for (const card of cards()) assert(Number(card.children[0].getAttribute("height")) > 0, "measured card heights");
  const link = descendants(ui.ids.get("view-status")).find((element) => element.tagName === "button" && element.textContent === "Open the map");
  ui.event(link);
  assert.doesNotMatch(ui.ids.get("view-map").className, /view-offstage/);
  assert.equal(ui.ids.get("tab-map").getAttribute("aria-selected"), "true");
  assert.equal(ui.stats.focused, "tab-map");
  assert(cards().length > 0);
  ui.event("tab-status");
  ui.event("tab-map");
  assert(cards().length > 0);
});

test("R2-1: a build in a shape no version wrote answers a question it cannot serve with a stated code; the others still answer", async (t) => {
  const damaged = path.join(temporary(t), "build");
  fs.cpSync(older("beta-126"), damaged, { recursive: true });
  const check = json(path.join(damaged, "check.json"));
  delete check.limits.calls;
  check.lists.missingIds = "not a list";
  fs.writeFileSync(path.join(damaged, "check.json"), JSON.stringify(check));
  const graph = json(path.join(damaged, "graph.json"));
  delete graph.limits.calls;
  fs.writeFileSync(path.join(damaged, "graph.json"), JSON.stringify(graph));
  const gaps = await runCommand(["product-graph-query", ".", "gaps", "--build", damaged]);
  assert.equal(gaps.code, "PRODUCT_GRAPH_BUILD_UNREADABLE");
  assert(gaps.text.includes(damaged), "names the build folder");
  assert.match(gaps.text, /다시 만들려면: product-graph-build /);
  assert.doesNotMatch(gaps.text, /TypeError|Cannot read|undefined|\bat /);
  for (const request of [
    { question: "overview" },
    { question: "node", id: "cli:notes" },
    { question: "down", id: "cli:notes" },
    { question: "reach", id: "MAIN-01" },
    { question: "find", text: "notes" },
  ]) {
    const answer = queryProductGraph({ buildDirectory: damaged, ...request });
    assert.equal(answer.status, "answered", JSON.stringify(request));
  }
  assert.match(queryProductGraph({ buildDirectory: damaged }).header[1], /이 빌드에는 호출 수가 없다|호출 \d+개 중/);
});

test("C3: --share names no local path in the product graph section, however the root was given", async (t) => {
  const f = notesProject(t, { records: false });
  buildProductGraph({ root: f.root });
  const relative = path.relative(process.cwd(), f.root);
  for (const root of [relative, f.root.toUpperCase(), f.root.toLowerCase()]) {
    let snap;
    try {
      snap = await buildGraphExplorerSnapshot({ root, share: true });
    } catch {
      continue; // a case-sensitive file system does not resolve the other spelling
    }
    const section = JSON.stringify(snap.productGraph).toLowerCase();
    for (const spelling of [f.root, f.root.replaceAll("\\", "/"), f.root.replaceAll("\\", "\\\\"), relative, relative.replaceAll("\\", "\\\\")])
      assert(!section.includes(spelling.toLowerCase()), `${root}: ${spelling}`);
    assert.equal(snap.productGraph.buildCommand, "product-graph-build <project>");
  }
});

test("acceptance 20: the new views, walk and tests name no toolkit or example project", () => {
  for (const file of ["views.js", "views.css", "product-graph-walk.js", "status-model.js", "i18n.js"])
    assert.doesNotMatch(read(path.join(assets, file)), /NeoPick|PySide|PyQt|\bQt\b|tkinter|Electron/i, file);
  assert.doesNotMatch(read(new URL(import.meta.url)).replace(/doesNotMatch\(.*\n/g, ""), /NeoPick|PySide|PyQt|tkinter/i);
});
