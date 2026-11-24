// Product graph 3, section 2b: self.attr.method() / this.attr.method()
// resolve when the class's own code says which class the attribute holds
// (synthetic products only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";

const lines = (...items) => `${items.join("\n")}\n`;
const RULES_HEAD = { schemaVersion: 1, kind: "LodeProductGraphEntryRules" };

function build(t, files) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-product-graph-attr-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, "source", name)), { recursive: true });
    fs.writeFileSync(path.join(base, "source", name), text);
  }
  fs.mkdirSync(path.join(base, "documents"));
  const rulesFile = path.join(base, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify({ ...RULES_HEAD, rules: [] }));
  buildProductGraph({ sourceRoot: path.join(base, "source"), documentsDirectory: path.join(base, "documents"), rulesFile, outputDirectory: path.join(base, "out") });
  return JSON.parse(fs.readFileSync(path.join(base, "out", "graph.json"), "utf8"));
}
const calls = (graph, from) =>
  graph.edges
    .filter((edge) => edge.type === "call" && edge.from === from)
    .map((edge) => edge.to)
    .sort();
const reasonOf = (graph, callee) => graph.referenceSummary.unresolvedByReason.filter((item) => item.callees.some((entry) => entry.callee === callee)).map((item) => item.reason);

test("Python: construction, declared type, typed parameter, a module binding; none, two classes, unannotated, union stay unresolved", (t) => {
  const graph = build(t, {
    "app/__init__.py": "",
    "app/pkg/__init__.py": "",
    "app/pkg/io.py": lines(
      "class Port:",
      "    def send(self):",
      "        return 1",
      "",
      "class Other:",
      "    def send(self):",
      "        return 2",
      "",
      "class Sub(Port):",
      "    pass",
    ),
    "app/user.py": lines(
      "from typing import Optional",
      "from app.pkg import io as iomod",
      "from app.pkg.io import Port, Other, Sub",
      "",
      "class Base:",
      "    def __init__(self):",
      "        self.shared = Port()",
      "",
      "class Built:",
      "    def __init__(self):",
      "        self.port = None",
      "        self.port = Port()",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Declared:",
      '    port: "Port"',
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Annotated:",
      "    def __init__(self):",
      "        self.port: Optional[Port] = None",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Given:",
      "    def __init__(self, io: Optional[Port]):",
      "        self.port = io",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Twice:",
      "    def __init__(self, flag):",
      "        self.port = Port()",
      "        if flag:",
      "            self.port = Other()",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Untyped:",
      "    def __init__(self, io):",
      "        self.port = io",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Either:",
      "    port: Port | Other",
      "",
      "    def run(self):",
      "        return self.port.send()",
      "",
      "class Child(Base):",
      "    def run(self):",
      "        return self.shared.send()",
      "",
      "class Missing:",
      "    def __init__(self):",
      "        self.port = Sub()",
      "",
      "    def run(self):",
      "        return self.port.close()",
      "",
      "class Through:",
      "    def __init__(self):",
      "        self.port = iomod.Port()",
      "",
      "    def run(self):",
      "        return self.port.send()",
    ),
  });
  const port = ["app/pkg/io.py#Port.send"];
  for (const owner of ["Built", "Declared", "Annotated", "Given", "Through"]) assert.deepEqual(calls(graph, `app/user.py#${owner}.run`), port, owner);
  for (const owner of ["Twice", "Untyped", "Either", "Child", "Missing"]) assert.deepEqual(calls(graph, `app/user.py#${owner}.run`), [], owner);
  assert.ok(reasonOf(graph, "port.send").includes("unknown-receiver"));
  // An attribute set only in the base class, and a member missing on a class with a base: inherited.
  assert.deepEqual(reasonOf(graph, "shared.send"), ["inherited"]);
  assert.deepEqual(reasonOf(graph, "port.close"), ["inherited"]);
});

test("TypeScript: construction, field type, parameter property, typed parameter, a private field, a namespace; the rest unresolved", (t) => {
  const graph = build(t, {
    "src/port.ts": lines(
      "export class Port {",
      "  send() {",
      "    return 1;",
      "  }",
      "}",
      "export class Other {",
      "  send() {",
      "    return 2;",
      "  }",
      "}",
      "export class Sub extends Port {}",
    ),
    "src/user.ts": lines(
      'import { Port, Other, Sub } from "./port";',
      'import * as ports from "./port";',
      "export class Base {",
      "  shared = new Port();",
      "}",
      "export class Built {",
      "  port: Port | null;",
      "  constructor() {",
      "    this.port = null;",
      "    this.port = new Port();",
      "  }",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Declared {",
      "  private port: Port;",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Property {",
      "  constructor(private readonly port: Port) {}",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Given {",
      "  port;",
      "  constructor(io: Port | undefined) {",
      "    this.port = io;",
      "  }",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Hidden {",
      "  #port = new Port();",
      "  run() {",
      "    return this.#port.send();",
      "  }",
      "}",
      "export class Spaced {",
      "  port = new ports.Port();",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Twice {",
      "  constructor(flag: boolean) {",
      "    this.port = new Port();",
      "    if (flag) {",
      "      this.port = new Other();",
      "    }",
      "  }",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Untyped {",
      "  constructor(io) {",
      "    this.port = io;",
      "  }",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Either {",
      "  port: Port | Other;",
      "  run() {",
      "    return this.port.send();",
      "  }",
      "}",
      "export class Child extends Base {",
      "  run() {",
      "    return this.shared.send();",
      "  }",
      "}",
      "export class Missing {",
      "  port = new Sub();",
      "  run() {",
      "    return this.port.close();",
      "  }",
      "}",
    ),
  });
  const port = ["src/port.ts#Port.send"];
  for (const owner of ["Built", "Declared", "Property", "Given", "Hidden", "Spaced"]) assert.deepEqual(calls(graph, `src/user.ts#${owner}.run`), port, owner);
  for (const owner of ["Twice", "Untyped", "Either", "Child", "Missing"]) assert.deepEqual(calls(graph, `src/user.ts#${owner}.run`), [], owner);
  assert.ok(reasonOf(graph, "port.send").includes("unknown-receiver"));
  assert.deepEqual(reasonOf(graph, "shared.send"), ["inherited"]);
  assert.deepEqual(reasonOf(graph, "port.close"), ["inherited"]);
});

test("a longer chain, an attribute copied to a local, or a call after another expression is not read", (t) => {
  const graph = build(t, {
    "src/port.js": lines("export class Port {", "  send() {", "    return 1;", "  }", "}"),
    "src/user.js": lines(
      'import { Port } from "./port.js";',
      "export class Holder {",
      "  constructor() {",
      "    this.port = new Port();",
      "  }",
      "  chain() {",
      "    return this.inner.port.send();",
      "  }",
      "  copied() {",
      "    const p = this.port;",
      "    return p.send();",
      "  }",
      "  other(x) {",
      "    return x.port.send();",
      "  }",
      "}",
    ),
  });
  for (const method of ["chain", "copied", "other"]) assert.deepEqual(calls(graph, `src/user.js#Holder.${method}`), [], method);
});
