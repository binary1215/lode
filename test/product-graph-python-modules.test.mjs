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
  return { result, graph };
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
