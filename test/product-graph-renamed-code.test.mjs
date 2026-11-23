// Product graph after source analysis 0.3.4: a nested function the old
// reading named without its container is one renamed 코드 node in the
// comparison, and a rule naming the old ID says what the new one is
// (synthetic products only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";

const lines = (...items) => `${items.join("\n")}\n`;
const RULES_HEAD = { schemaVersion: 1, kind: "LodeProductGraphEntryRules" };

function project(t, files, rules) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-product-graph-renamed-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, "source", name)), { recursive: true });
    fs.writeFileSync(path.join(base, "source", name), text);
  }
  fs.mkdirSync(path.join(base, "documents"));
  const rulesFile = path.join(base, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify({ ...RULES_HEAD, rules }, null, 2));
  const out = path.join(base, "out");
  const build = () => buildProductGraph({ sourceRoot: path.join(base, "source"), documentsDirectory: path.join(base, "documents"), rulesFile, outputDirectory: out });
  return { base, out, build };
}

const SOURCE = {
  "src/registry.js": lines('import { run } from "./tools.js";', 'export const TOOLS = [{ name: "run", run: run }];'),
  "src/tools.js": lines("export function run(options = {}) {", "  function inner() {", "    return 1;", "  }", "  return inner();", "}"),
};
const toolRule = (extra = {}) => ({ 종류: "tool", 판단: true, 파일: ["src/registry.js"], 패턴: 'name: "(\\w+)"', "처리 코드": "항목", ...extra });

test("a node the reader renamed is counted apart, not as 신규 or 사라짐", (t) => {
  const p = project(t, SOURCE, [toolRule()]);
  p.build();
  // The baseline as the 0.3.3 reading wrote it: the nested function had no
  // container prefix. Same source text, so the difference is the reader's.
  const file = path.join(p.out, "baseline.json");
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(baseline.nodes.some(([id]) => id === "src/tools.js#run.inner"));
  baseline.reader.sourceAnalysis = "0.3.3";
  fs.writeFileSync(file, JSON.stringify(baseline).replaceAll("src/tools.js#run.inner", "src/tools.js#inner"));
  const second = p.build();
  const changes = second.changes;
  assert.equal(changes.moved.reader, true);
  assert.deepEqual(changes.readerChanged.renamed, [{ from: "src/tools.js#inner", to: "src/tools.js#run.inner" }]);
  assert.equal(changes.counts.added, 0);
  assert.equal(changes.counts.removed, 0);
  assert.deepEqual(changes.reachChanged, []);
  assert.equal(changes.counts.reviewAgain, 0);
  assert.match(second.text, /\n- 읽는 방식이 달라져 이름이 바뀐 코드 1개 \(기준과 같은 파일, 같은 첫 줄, 같은 마지막 이름\. 신규와 사라짐에 넣지 않는다\)\n/);
});

test("a rule naming a nested function by its old ID names the new one", (t) => {
  const p = project(t, SOURCE, [toolRule({ 입구: ["src/tools.js#inner"] })]);
  const { lists, text } = p.build();
  const issue = lists.ruleIssues.find((item) => item.path === "src/tools.js#inner");
  assert.equal(issue.reason, "규칙이 가리키는 코드가 없음 — 이름이 바뀜: `src/tools.js#run.inner`");
  assert.deepEqual(issue.renamed, ["src/tools.js#run.inner"]);
  assert.match(text, /tool: src\/tools\.js#inner — 규칙이 가리키는 코드가 없음 — 이름이 바뀜: `src\/tools\.js#run\.inner`/);
});

test("with two candidates the issue lists both", (t) => {
  const files = {
    ...SOURCE,
    "src/tools.js": lines(
      "export function run(options = {}) {",
      "  function inner() {",
      "    return 1;",
      "  }",
      "  return inner();",
      "}",
      "export function stop({ now } = {}) {",
      "  function inner() {",
      "    return now;",
      "  }",
      "  return inner();",
      "}",
    ),
  };
  const p = project(t, files, [toolRule({ 입구: ["src/tools.js#inner"] })]);
  const { lists } = p.build();
  const issue = lists.ruleIssues.find((item) => item.path === "src/tools.js#inner");
  assert.equal(issue.reason, "규칙이 가리키는 코드가 없음 — 이름이 바뀌었을 수 있음: `src/tools.js#run.inner`, `src/tools.js#stop.inner`");
  assert.deepEqual(issue.renamed, ["src/tools.js#run.inner", "src/tools.js#stop.inner"]);
});

// ---------- 4.3: a 화면→코드 row edited to the renamed ID ----------

const { confirmationStatus } = await import("../scripts/lib/world/product-graph-confirmations.mjs");
const READER_NOW = { generator: "lode-product-graph", graphVersion: 2, sourceAnalysis: "0.3.4" };
const READER_OLD = { ...READER_NOW, sourceAnalysis: "0.3.3" };
const DOC = "화면/main.md";

function checkGraph(rowTargets, extraNodes = []) {
  const nodes = [{ id: "screen:main", type: "화면", contentSha256: "s" }, ...[...rowTargets, ...extraNodes].map((id) => ({ id, type: "코드", contentSha256: `c-${id}` }))];
  const edges = rowTargets.map((to, index) => ({ type: "화면→코드", from: "screen:main", to, at: { path: DOC, line: 3 + index }, basis: { status: "승인" } }));
  return { nodes, edges, inputs: { reader: READER_NOW } };
}
const documents = [{ path: DOC, approvable: true, approvalDigest: "d" }];
const record = (to, reader = READER_OLD, checkId = `check-${to}`) => ({
  checkId,
  by: "agent-checked",
  checkedAt: "2026-11-20T00:00:00.000Z",
  reader,
  supersedes: [],
  items: [{ kind: "documentRow", document: DOC, type: "화면→코드", from: "screen:main", to, documentTextSha256: "d", basis: [{ id: to, contentSha256: `c-${to}` }] }],
});
const status = (graph, records) => confirmationStatus({ graph, meaningDocument: null, documents, records });

test("4.3: one record of the old reader matched by name shows as read differently, with the old ID", () => {
  const result = status(checkGraph(["src/view.js#outer.draw"]), [record("src/view.js#draw")]);
  assert.equal(result.counts.current, 0);
  assert.equal(result.counts.neverChecked, 0);
  assert.equal(result.otherReader.length, 1);
  assert.equal(result.otherReader[0].to, "src/view.js#outer.draw");
  assert.equal(result.otherReader[0].matchedByName.to, "src/view.js#draw");
  assert.match(result.otherReader[0].matchedByName.note, /이름으로 맞춘 기록: 예전 ID src\/view\.js#draw\(같은 키가 아니다\)/);
});

test("4.3: two candidates, or one record two rows could take, stay never checked and list the candidates", () => {
  let result = status(checkGraph(["src/view.js#outer.draw"]), [record("src/view.js#draw~1"), record("src/view.js#draw~2")]);
  assert.equal(result.counts.otherReader, 0);
  assert.deepEqual(result.neverChecked[0].renamedCandidates, ["src/view.js#draw~1", "src/view.js#draw~2"]);
  result = status(checkGraph(["src/view.js#outer.draw", "src/view.js#other.draw"]), [record("src/view.js#draw")]);
  assert.equal(result.counts.otherReader, 0);
  assert.deepEqual(
    result.neverChecked.map((item) => item.renamedCandidates),
    [["src/view.js#draw"], ["src/view.js#draw"]],
  );
});

test("4.3: a record of the current reader is never matched by name", () => {
  const result = status(checkGraph(["src/view.js#outer.draw"]), [record("src/view.js#draw", READER_NOW)]);
  assert.equal(result.counts.otherReader, 0);
  assert.equal(result.counts.neverChecked, 1);
  assert.equal(result.neverChecked[0].renamedCandidates, undefined);
});

test("4.3: an old row whose code still resolves, or that is a current row's own key, is not a match for a new row", () => {
  // The row to #a.run was removed from the document and a new row to #b.run written; #a.run still exists.
  let result = status(checkGraph(["src/tools.js#b.run"], ["src/tools.js#a.run"]), [record("src/tools.js#a.run")]);
  assert.equal(result.counts.otherReader, 0);
  assert.equal(result.neverChecked[0].renamedCandidates, undefined);
  // Both rows are in the document: the old record is #a.run's own (by key), never #b.run's.
  result = status(checkGraph(["src/tools.js#a.run", "src/tools.js#b.run"]), [record("src/tools.js#a.run")]);
  assert.deepEqual(
    result.otherReader.map((item) => [item.to, item.matchedByName ?? null]),
    [["src/tools.js#a.run", null]],
  );
  assert.deepEqual(
    result.neverChecked.map((item) => [item.to, item.renamedCandidates ?? null]),
    [["src/tools.js#b.run", null]],
  );
});
