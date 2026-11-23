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
