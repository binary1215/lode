// Product graph 3: Python calls through a module imported by name resolve
// like a namespace import (synthetic products only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";

const lines = (...items) => `${items.join("\n")}\n`;
const RULES_HEAD = { schemaVersion: 1, kind: "LodeProductGraphEntryRules" };

function build(t, files, rules = []) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-product-graph-pymod-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, "source", name)), { recursive: true });
    fs.writeFileSync(path.join(base, "source", name), text);
  }
  fs.mkdirSync(path.join(base, "documents"));
  const rulesFile = path.join(base, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify({ ...RULES_HEAD, rules }, null, 2));
  const out = path.join(base, "out");
  const result = buildProductGraph({ sourceRoot: path.join(base, "source"), documentsDirectory: path.join(base, "documents"), rulesFile, outputDirectory: out });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  return { result, graph, out };
}

const PACKAGE = {
  "app/__init__.py": "",
  "app/pkg/__init__.py": lines("from .impl import helper", "", "def clash():", "    return 0"),
  "app/pkg/mod.py": lines("def f():", "    return 1", "", "class Store:", "    def __init__(self):", "        self.items = []", "", "    def add(self, item):", "        self.items.append(item)"),
  "app/pkg/impl.py": lines("def helper():", "    return 2"),
  "app/pkg/helper.py": lines("def run():", "    return 3"),
  "app/pkg/clash.py": lines("def f():", "    return 4"),
  "app/pkg/sub/__init__.py": "",
  "app/pkg/sub/deep.py": lines("def h():", "    return 5"),
};

function edgesFrom(graph, from, type = "call") {
  return graph.edges
    .filter((edge) => edge.type === type && edge.from === from)
    .map((edge) => edge.to)
    .sort();
}
function unresolved(graph, reason) {
  return graph.referenceSummary.unresolvedByReason.find((item) => item.reason === reason).callees.map((item) => item.callee).sort();
}

test("calls through a module imported by name resolve like a namespace import", (t) => {
  const { graph } = build(t, {
    ...PACKAGE,
    "app/user.py": lines(
      "import app.pkg.mod",
      "from app.pkg import mod",
      "from app.pkg import mod as m",
      "from app.pkg import sub",
      "",
      "def absolute():",
      "    return mod.f()",
      "",
      "def alias():",
      "    return m.f()",
      "",
      "def three_parts():",
      "    return app.pkg.mod.f()",
      "",
      "def two_steps():",
      "    return sub.deep.h()",
      "",
      "def construct():",
      "    return mod.Store()",
      "",
      "def instance():",
      "    v = m.Store()",
      "    v.add(1)",
      "",
      "def value():",
      "    return run_later(mod.f)",
      "",
      "def run_later(callback):",
      "    return callback()",
    ),
    "app/pkg/user2.py": lines("from . import mod", "from .sub import deep", "from .. import pkg as p", "", "def relative():", "    mod.f()", "    deep.h()", "    p.mod.f()"),
  });
  assert.deepEqual(edgesFrom(graph, "app/user.py#absolute"), ["app/pkg/mod.py#f"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#alias"), ["app/pkg/mod.py#f"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#three_parts"), ["app/pkg/mod.py#f"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#two_steps"), ["app/pkg/sub/deep.py#h"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#construct"), ["app/pkg/mod.py#Store"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#instance"), ["app/pkg/mod.py#Store", "app/pkg/mod.py#Store.add"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#value", "callback"), ["app/pkg/mod.py#f"]);
  assert.deepEqual(edgesFrom(graph, "app/pkg/user2.py#relative"), ["app/pkg/mod.py#f", "app/pkg/sub/deep.py#h"]);
});

test("a declaration or re-export in the package wins over a module of the same name", (t) => {
  const { graph } = build(t, {
    ...PACKAGE,
    "app/user.py": lines("from app.pkg import helper, clash", "", "def reexported():", "    return helper()", "", "def not_the_module():", "    helper.run()", "    clash.f()"),
  });
  assert.deepEqual(edgesFrom(graph, "app/user.py#reexported"), ["app/pkg/impl.py#helper"]);
  assert.deepEqual(edgesFrom(graph, "app/user.py#not_the_module"), []);
});

test("what does not walk to a read module stays unresolved, with the reason", (t) => {
  const { graph } = build(t, {
    ...PACKAGE,
    "app/user.py": lines(
      "import app.pkg.mod",
      "from app.pkg import missing",
      "from .gone import thing",
      "from app.pkg import mod",
      "",
      "def negatives(mod2):",
      "    missing.f()",
      "    thing()",
      "    app.pkg.nomod.f()",
      "",
      "def shadowed(mod):",
      "    mod.f()",
    ),
  });
  assert.deepEqual(edgesFrom(graph, "app/user.py#negatives"), []);
  assert.deepEqual(edgesFrom(graph, "app/user.py#shadowed"), []);
  assert.ok(unresolved(graph, "module-not-read").includes("thing"));
  assert.ok(unresolved(graph, "module-not-read").includes("nomod.f"));
  assert.ok(unresolved(graph, "rest").includes("missing.f"));
  const reason = graph.referenceSummary.unresolvedByReason.find((item) => item.reason === "module-not-read");
  assert.match(reason.settle, /스캔 범위/);
});

// ---------- 3: answers say where a path was lost ----------

const { queryProductGraph } = await import("../scripts/lib/world/product-graph-query.mjs");
const LOST = {
  "src/registry.js": lines('import { runA, runB } from "./tools.js";', 'export const TOOLS = [{ name: "alpha", run: runA }, { name: "beta", run: runB }];'),
  "src/tools.js": lines(
    "export function runA(store) {",
    "  store.add(1);",
    "  return helperA();",
    "}",
    "function helperA() {",
    '  dispatch("x");',
    "  orphan();",
    "}",
    "export function runB() {",
    "  return 2;",
    "}",
    "export class Box {",
    "  add(x) {",
    "    return x;",
    "  }",
    "  append(x) {",
    "    return x;",
    "  }",
    "}",
    "export function late(list) {",
    "  list.append(1);",
    "}",
  ),
  "src/other.js": lines("export function orphan() {", "  return 3;", "}", "export function setTimeout() {", "  return 4;", "}"),
};
const TOOL_RULE = { 종류: "tool", 판단: true, 파일: ["src/registry.js"], 패턴: 'name: "(\\w+)"', "처리 코드": "항목" };

const lostProject = (t) => build(t, LOST, [TOOL_RULE]);

test("reach, the 기능 node and tree say how many unresolved calls the path holds (3.2, 3.3)", (t) => {
  const { graph, out } = lostProject(t);
  const ask = (question, id) => queryProductGraph({ buildDirectory: out, question, id });
  const alpha = graph.nodes.find((node) => node.type === "기능" && node.id.includes("alpha")).id;
  const beta = graph.nodes.find((node) => node.type === "기능" && node.id.includes("beta")).id;
  assert.deepEqual(graph.nodes.find((node) => node.id === "src/tools.js#helperA").unresolvedCalls.made, {
    count: 2,
    byReason: { "no-declaration": 1, "declared-elsewhere": 1 },
    callees: [
      { callee: "dispatch", line: 6 },
      { callee: "orphan", line: 7 },
    ],
  });
  const reach = ask("reach", alpha);
  assert.match(reach.text, /\n {2}이 길에서 못 푼 호출 3곳 \(제품 코드일 수 있음\): 닿는 범위가 실제보다 좁을 수 있다\n/);
  assert.match(reach.text, /\n {4}src\/tools\.js#helperA — 2곳: `dispatch` \(줄 6\), `orphan` \(줄 7\)\n/);
  assert.equal(reach.reach.lostCalls.count, 3);
  assert.deepEqual(
    reach.reach.lostCalls.nodes.map((item) => [item.id, item.count]),
    [
      ["src/tools.js#helperA", 2],
      ["src/tools.js#runA", 1],
    ],
  );
  assert.match(ask("node", alpha).text, /이 길에서 못 푼 호출 3곳/);
  const tree = ask("tree", alpha).text;
  assert.match(tree, /\n\s+못 푼 호출 2곳: `dispatch`, `orphan`\n/);
  assert.match(tree, /\n\s+못 푼 호출 1곳: `store\.add`\n/);
  for (const answer of [ask("reach", beta), ask("node", beta), ask("tree", beta)]) assert.doesNotMatch(answer.text, /못 푼 호출/);
});

test("a declaration nothing calls names the unresolved calls that may be it (3.4)", (t) => {
  const { graph, out } = lostProject(t);
  const ask = (question, id) => queryProductGraph({ buildDirectory: out, question, id });
  const up = ask("up", "src/other.js#orphan");
  assert.match(up.text, /이 선언일 수 있는 못 푼 호출 1곳 \(이름이 같은 점 없는 호출\. 이 선언을 부른다는 뜻은 아니다\): src\/tools\.js:7/);
  assert.match(ask("reach", "src/other.js#orphan").text, /이 선언일 수 있는 못 푼 호출 1곳/);
  assert.deepEqual(up.rows.find((row) => row.mayBeThis).mayBeThis, { count: 1, places: [{ callee: "orphan", path: "src/tools.js", line: 7 }] });
  // A built-in name, and a method called only on an unknown receiver: nothing said.
  assert.equal(graph.nodes.find((node) => node.id === "src/other.js#setTimeout").unresolvedCalls, undefined);
  assert.doesNotMatch(ask("up", "src/tools.js#Box.append").text, /이 선언일 수 있는/);
  // Something calls helperA: nothing said even if a name matched.
  assert.doesNotMatch(ask("up", "src/tools.js#helperA").text, /이 선언일 수 있는/);
});

// ---------- 5: graph version 3 against older baselines and records ----------

test("against a version-2 baseline, newly resolved edges show as the reader's, never 닿는 코드가 바뀜 or 다시 볼 것", (t) => {
  const files = { ...PACKAGE, "app/user.py": lines("from app.pkg import mod", "", "def absolute():", "    return mod.f()") };
  const rules = [{ 종류: "cli", 판단: true, 파일: ["app/user.py"], 패턴: "def (absolute)", "처리 코드": "줄을 감싼 코드" }];
  const { out } = build(t, files, rules);
  // The baseline as version 2 wrote it: the call through the module was unresolved.
  const file = path.join(out, "baseline.json");
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(baseline.reader.graphVersion, 3);
  baseline.reader.graphVersion = 2;
  const id = (part) => (typeof part === "number" ? baseline.nodes[part][0] : part);
  const before = baseline.edges.length;
  baseline.edges = baseline.edges.filter((edge) => !(edge[0] === "call" && id(edge[1]) === "app/user.py#absolute" && id(edge[2]) === "app/pkg/mod.py#f"));
  assert.equal(baseline.edges.length, before - 1);
  for (const node of baseline.nodes) if (node[1] === "기능") node[6] = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(baseline));
  const base = path.dirname(out);
  const second = buildProductGraph({
    sourceRoot: path.join(base, "source"),
    documentsDirectory: path.join(base, "documents"),
    rulesFile: path.join(base, "rules.json"),
    outputDirectory: out,
  });
  const changes = second.changes;
  assert.equal(changes.moved.reader, true);
  assert.equal(changes.edges.call.added, 1);
  assert.equal(changes.counts.reachChanged, 0);
  assert.equal(changes.counts.reviewAgain, 0);
  assert.deepEqual(changes.readerChanged.reach, ["cli:absolute"]);
});

test("a confirmation record made under graph version 2 reads as made under another reader", async () => {
  const { confirmationStatus } = await import("../scripts/lib/world/product-graph-confirmations.mjs");
  const now = { generator: "lode-product-graph", graphVersion: 3, sourceAnalysis: "0.3.4" };
  const DOC = "화면/main.md";
  const graph = {
    nodes: [
      { id: "screen:main", type: "화면", contentSha256: "s" },
      { id: "src/view.js#draw", type: "코드", contentSha256: "c" },
    ],
    edges: [{ type: "화면→코드", from: "screen:main", to: "src/view.js#draw", at: { path: DOC, line: 3 }, basis: { status: "승인" } }],
    inputs: { reader: now },
  };
  const record = {
    checkId: "check-1",
    by: "agent-checked",
    checkedAt: "2026-11-20T00:00:00.000Z",
    reader: { ...now, graphVersion: 2 },
    supersedes: [],
    items: [{ kind: "documentRow", document: DOC, type: "화면→코드", from: "screen:main", to: "src/view.js#draw", documentTextSha256: "d", basis: [{ id: "src/view.js#draw", contentSha256: "c" }] }],
  };
  const result = confirmationStatus({ graph, meaningDocument: null, documents: [{ path: DOC, approvable: true, approvalDigest: "d" }], records: [record] });
  assert.equal(result.counts.current, 0);
  assert.equal(result.otherReader.length, 1);
});
