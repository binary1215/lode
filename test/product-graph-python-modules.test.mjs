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
  const result = buildProductGraph({
    sourceRoot: path.join(base, "source"),
    documentsDirectory: path.join(base, "documents"),
    rulesFile,
    outputDirectory: out,
  });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  return { result, graph, out };
}

const PACKAGE = {
  "app/__init__.py": "",
  "app/pkg/__init__.py": lines("from .impl import helper", "", "def clash():", "    return 0"),
  "app/pkg/mod.py": lines(
    "def f():",
    "    return 1",
    "",
    "class Store:",
    "    def __init__(self):",
    "        self.items = []",
    "",
    "    def add(self, item):",
    "        self.items.append(item)",
  ),
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
  return graph.referenceSummary.unresolvedByReason
    .find((item) => item.reason === reason)
    .callees.map((item) => item.callee)
    .sort();
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
    "app/pkg/user2.py": lines(
      "from . import mod",
      "from .sub import deep",
      "from .. import pkg as p",
      "",
      "def relative():",
      "    mod.f()",
      "    deep.h()",
      "    p.mod.f()",
    ),
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
    "app/user.py": lines(
      "from app.pkg import helper, clash",
      "",
      "def reexported():",
      "    return helper()",
      "",
      "def not_the_module():",
      "    helper.run()",
      "    clash.f()",
    ),
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
  // S1: neither a name of the package nor a read module — a submodule not read.
  assert.ok(unresolved(graph, "module-not-read").includes("missing.f"));
  const reason = graph.referenceSummary.unresolvedByReason.find((item) => item.reason === "module-not-read");
  assert.match(reason.settle, /스캔 범위/);
});

// M5: a head that follows an expression is a member of something else, and a
// longer name never falls back to the import of its second-to-last segment.
test("a module name after an expression, or inside a longer name, is not the import", (t) => {
  const { graph } = build(t, {
    ...PACKAGE,
    "app/user.py": lines(
      "import app.pkg.mod as pm",
      "from app.pkg import mod",
      "",
      "def continued(obj):",
      "    value = (obj",
      "             .mod.f())",
      "    return value",
      "",
      "def attribute(obj):",
      "    return obj.pm.f()",
      "",
      "class Holder:",
      "    def run(self):",
      "        return self.pm.f()",
      "",
      "def called():",
      "    return make().mod.f()",
      "",
      "def plain():",
      "    return pm.f()",
    ),
  });
  for (const id of ["app/user.py#continued", "app/user.py#attribute", "app/user.py#Holder.run", "app/user.py#called"])
    assert.deepEqual(edgesFrom(graph, id), [], id);
  assert.deepEqual(edgesFrom(graph, "app/user.py#plain"), ["app/pkg/mod.py#f"]);
});

// M6: an import inside a function, with an alias, is the import.
test("a function-local import with an alias resolves", (t) => {
  const { graph } = build(t, {
    ...PACKAGE,
    "app/user.py": lines(
      "def a():",
      "    from app.pkg import mod as lm",
      "    return lm.f()",
      "",
      "def b():",
      "    import app.pkg.mod as pm2",
      "    return pm2.f()",
      "",
      "def c():",
      "    from app.pkg.mod import f as ff",
      "    return ff()",
      "",
      "def d(path):",
      "    with open(path) as handle:",
      "        return handle.read()",
    ),
  });
  for (const id of ["app/user.py#a", "app/user.py#b", "app/user.py#c"]) assert.deepEqual(edgesFrom(graph, id), ["app/pkg/mod.py#f"], id);
  assert.deepEqual(edgesFrom(graph, "app/user.py#d"), []);
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
const TOOL_RULE_GO = { ...TOOL_RULE };

test("reach, the 기능 node and tree say how many unresolved calls the path holds (3.2, 3.3)", (t) => {
  const { graph, out } = lostProject(t);
  const ask = (question, id) => queryProductGraph({ buildDirectory: out, question, id });
  const alpha = graph.nodes.find((node) => node.type === "기능" && node.id.includes("alpha")).id;
  const beta = graph.nodes.find((node) => node.type === "기능" && node.id.includes("beta")).id;
  const made = (id) => graph.nodes.find((node) => node.id === id).unresolvedCalls.made;
  assert.deepEqual(made("src/tools.js#helperA"), {
    count: 2,
    byReason: { "no-declaration": 1, "declared-elsewhere": 1 },
    callees: [
      { callee: "dispatch", line: 6 },
      { callee: "orphan", line: 7 },
    ],
    members: [],
  });
  // A method call on a receiver of unknown type is the other kind, counted by name.
  assert.deepEqual(made("src/tools.js#runA"), { count: 0, byReason: {}, callees: [], members: [{ name: "add", count: 1, line: 2 }] });
  const reach = ask("reach", alpha);
  const count = "이 길에서 못 푼 호출 (제품 코드일 수 있음) — 이름으로 부른 것 2곳, 받는 쪽 타입을 모르는 메서드 호출 1곳: 닿는 범위가 실제보다 좁을 수 있다";
  assert.ok(reach.text.includes(`\n  ${count}\n`), reach.text);
  assert.ok(
    reach.text.includes(
      "\n  못 푼 호출이 있는 곳 (이름으로 부른 것이 많은 노드, 메서드 호출의 이름별 수):\n    src/tools.js#helperA — 2곳: `dispatch` (줄 6), `orphan` (줄 7)\n    받는 쪽 타입을 모르는 메서드 호출 1곳 — 이름별: `add` 1 (빌드 전체 1, 예: src/tools.js:2)\n",
    ),
    reach.text,
  );
  assert.deepEqual(reach.reach.lostCalls, {
    named: { count: 2, nodes: [{ id: "src/tools.js#helperA", count: 2, callees: made("src/tools.js#helperA").callees }] },
    receiver: { count: 1, names: [{ name: "add", count: 1, buildCount: 1, example: { path: "src/tools.js", line: 2 } }], distinctNames: 1 },
  });
  // The row fields of the read chain's result shape.
  assert.ok(reach.rows.some((row) => row.lostCalls) && reach.rows.some((row) => row.lostCallsIn) && reach.rows.some((row) => row.lostMethodNames));
  // S2: the count row on every page, the detail on the last.
  const first = queryProductGraph({ buildDirectory: out, question: "reach", id: alpha, limit: 1 });
  assert.ok(first.page.remaining > 0);
  assert.ok(first.text.includes(count));
  assert.doesNotMatch(first.text, /이름별/);
  assert.ok(ask("node", alpha).text.includes(count));
  const tree = ask("tree", alpha).text;
  assert.match(tree, /\n\s+못 푼 호출 — 이름으로 부른 것 2곳: `dispatch`, `orphan`\n/);
  // A node with only method calls on an unknown receiver gets its row too.
  assert.match(tree, /\n\s+못 푼 호출 — 받는 쪽 타입을 모르는 메서드 호출 1곳: `\.add`\n/);
  for (const answer of [ask("reach", beta), ask("node", beta), ask("tree", beta)]) assert.doesNotMatch(answer.text, /못 푼 호출/);
});

test("a declaration with no resolved caller names the unresolved calls that may be it (3.4)", (t) => {
  const { graph, out, result } = build(
    t,
    {
      ...LOST,
      // (b) two classes declare refresh; it is called only on receivers of unknown type.
      "src/views.js": lines(
        "export class Panel {",
        "  refresh() {",
        "    return 1;",
        "  }",
        "}",
        "export class Chart {",
        "  refresh() {",
        "    return 2;",
        "  }",
        "}",
      ),
      "src/caller.js": lines(
        "export function update(view) {",
        "  view.refresh();",
        "}",
        "export function again(other) {",
        "  other.refresh();",
        "  helperA();",
        "}",
      ),
      // (c) a declaration named like a built-in global, called bare elsewhere.
      "app/util.py": lines("def len(items):", "    return 0"),
      "app/main.py": lines("def count(items):", "    return len(items)"),
      // M4: a parameter's call is no declaration's; a member is not called by its bare name.
      "app/runner.py": lines("def runner(finish):", "    return finish()", "", "class Tool:", "    def finish(self):", "        return 1"),
      // M4: a local helper inside a function is no member: not matched, and not counted in K.
      "src/local.js": lines("export function outer() {", "  function refresh() {", "    return 0;", "  }", "  return 1;", "}"),
    },
    [TOOL_RULE],
  );
  const ask = (question, id) => queryProductGraph({ buildDirectory: out, question, id });
  const possible = (id) => graph.nodes.find((node) => node.id === id).unresolvedCalls?.mayBeThis;
  // (a) a bare call of its name.
  const up = ask("up", "src/other.js#orphan");
  assert.match(up.text, /이 선언일 수 있는 못 푼 호출 1곳 \(이름만 부른 호출\. 이 선언을 부른다는 뜻은 아니다\): src\/tools\.js:7\n/);
  assert.deepEqual(up.rows.find((row) => row.mayBeThis).mayBeThis, {
    count: 1,
    bare: { count: 1, places: [{ callee: "orphan", path: "src/tools.js", line: 7 }] },
  });
  assert.match(ask("reach", "src/other.js#orphan").text, /이 선언일 수 있는 못 푼 호출 1곳/);
  assert.match(ask("node", "src/other.js#orphan").text, /이 선언일 수 있는 못 푼 호출 1곳/);
  // (b) a method called only on receivers of unknown type, its name declared twice.
  for (const id of ["src/views.js#Panel.refresh", "src/views.js#Chart.refresh"]) {
    assert.match(
      ask("up", id).text,
      /이 선언일 수 있는 못 푼 호출 2곳 \(받는 쪽 타입을 모름, 같은 이름의 선언 2개\. 이 선언을 부른다는 뜻은 아니다\): src\/caller\.js:2, src\/caller\.js:5\n/,
    );
    assert.deepEqual(possible(id).member, {
      count: 2,
      places: [
        { callee: "view.refresh", path: "src/caller.js", line: 2 },
        { callee: "other.refresh", path: "src/caller.js", line: 5 },
      ],
      sameName: 2,
    });
  }
  assert.equal(possible("app/runner.py#Tool.finish"), undefined);
  assert.equal(possible("src/local.js#outer.refresh"), undefined);
  // (c) calls the built-in rule settles never count.
  assert.equal(possible("app/util.py#len"), undefined);
  assert.doesNotMatch(ask("up", "app/util.py#len").text, /이 선언일 수 있는/);
  assert.equal(possible("src/other.js#setTimeout"), undefined);
  // (d) helperA has a resolved caller (runA): no line, although a bare call of its name is unresolved.
  assert.equal(possible("src/tools.js#helperA").count, 1);
  assert.doesNotMatch(ask("up", "src/tools.js#helperA").text, /이 선언일 수 있는/);
  // (e) a method named like a built-in type's: the line with its count, and the limits block says why.
  assert.match(
    ask("up", "src/tools.js#Box.append").text,
    /이 선언일 수 있는 못 푼 호출 1곳 \(받는 쪽 타입을 모름\. 이 선언을 부른다는 뜻은 아니다\): src\/tools\.js:21\n/,
  );
  assert.ok(
    result.text.includes("내장 타입도 가진 메서드 이름(get, append 같은 것)은 제품의 것과 가를 수 없어, 그런 선언에는 가능한 호출이 많이 붙을 수 있다."),
  );
});

// M3: method names on an unknown receiver show rarest first in the whole build.
test("method names on an unknown receiver are ordered by how rare they are in the build", (t) => {
  const { graph, out } = build(
    t,
    {
      "src/registry.js": lines('import { go } from "./run.js";', 'export const TOOLS = [{ name: "go", run: go }];'),
      "src/run.js": lines(
        "export function go(map, job) {",
        "  map.get(1);",
        "  map.get(2);",
        "  job.settleOnce();",
        "}",
        "export function elsewhere(map) {",
        "  map.get(3);",
        "  map.get(4);",
        "}",
      ),
      "src/store.js": lines("export class Store {", "  get(key) {", "    return key;", "  }", "  settleOnce() {", "    return 1;", "  }", "}"),
    },
    [TOOL_RULE_GO],
  );
  assert.deepEqual(graph.referenceSummary.unresolvedMethodNames, { get: 4, settleOnce: 1 });
  const reach = queryProductGraph({ buildDirectory: out, question: "reach", id: "tool:go" });
  assert.deepEqual(
    reach.reach.lostCalls.receiver.names.map((item) => [item.name, item.count, item.buildCount]),
    [
      ["settleOnce", 1, 1],
      ["get", 2, 4],
    ],
  );
  assert.ok(reach.text.includes("이름별: `settleOnce` 1 (빌드 전체 1, 예: src/run.js:4), `get` 2 (빌드 전체 4, 예: src/run.js:2)"), reach.text);
  const tree = queryProductGraph({ buildDirectory: out, question: "tree", id: "tool:go" }).text;
  assert.match(tree, /못 푼 호출 — 받는 쪽 타입을 모르는 메서드 호출 3곳: `\.settleOnce`, `\.get`\n/);
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
    items: [
      {
        kind: "documentRow",
        document: DOC,
        type: "화면→코드",
        from: "screen:main",
        to: "src/view.js#draw",
        documentTextSha256: "d",
        basis: [{ id: "src/view.js#draw", contentSha256: "c" }],
      },
    ],
  };
  const result = confirmationStatus({ graph, meaningDocument: null, documents: [{ path: DOC, approvable: true, approvalDigest: "d" }], records: [record] });
  assert.equal(result.counts.current, 0);
  assert.equal(result.otherReader.length, 1);
});
