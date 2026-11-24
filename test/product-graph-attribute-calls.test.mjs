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

// Review round 2: a construction counts only when it is the whole assigned
// expression (R2-1), and every place the attribute is an assignment target in
// the class must be one that was read (R2-2); otherwise the call stays a
// method call on a receiver of unknown type.
const PY_IO = lines(
  "class RealIO:",
  "    def start(self):",
  "        return 1",
  "",
  "class FakeIO:",
  "    def start(self):",
  "        return 2",
  "",
  "class Builder:",
  "    def start(self):",
  "        return 3",
  "",
  "    def build(self):",
  "        return RealIO()",
);
const RUN_PY = ["", "    def run(self):", "        return self.io.start()"];

test("Python: an expression around a construction, or another assignment target, leaves the attribute unknown", (t) => {
  const cases = {
    A: ["    def __init__(self, live):", "        self.io = RealIO() if live else FakeIO()"],
    B: ["    def __init__(self):", "        self.io = Builder().build()"],
    G: ["    def __init__(self):", "        self.io = Builder(", "        ).build()"],
    C: ["    def __init__(self):", "        self.io = RealIO()", "", "    def swap(self, other):", "        self.io, self.spare = other, None"],
    D: ["    def __init__(self):", "        self.io = RealIO()", "", "    def flip(self, flag):", "        if flag: self.io = FakeIO()"],
    J: ["    def __init__(self):", "        self.io = RealIO()", "", "    def open(self):", "        with opener() as self.io:", "            pass"],
    Or: ["    def __init__(self, io):", "        self.io = io or RealIO()"],
    Chained: ["    def __init__(self):", "        self.io = self.other = RealIO()"],
    Augmented: ["    def __init__(self):", "        self.io = RealIO()", "", "    def more(self):", "        self.io += 1"],
    Kept: ["    def __init__(self):", "        self.io = None", "        self.io = RealIO()  # the real one"],
  };
  const files = { "app/__init__.py": "", "app/io.py": PY_IO };
  for (const [name, body] of Object.entries(cases))
    files[`app/case_${name.toLowerCase()}.py`] = lines("from app.io import RealIO, FakeIO, Builder", "", `class Case${name}:`, ...body, ...RUN_PY);
  const graph = build(t, files);
  for (const name of Object.keys(cases)) {
    const expected = name === "Kept" ? ["app/io.py#RealIO.start"] : [];
    assert.deepEqual(calls(graph, `app/case_${name.toLowerCase()}.py#Case${name}.run`), expected, name);
  }
});

const TS_IO = lines(
  "export class RealIO {",
  "  start() {",
  "    return 1;",
  "  }",
  "}",
  "export class FakeIO {",
  "  start() {",
  "    return 2;",
  "  }",
  "}",
  "export class Builder {",
  "  start() {",
  "    return 3;",
  "  }",
  "  build() {",
  "    return new RealIO();",
  "  }",
  "}",
);
const RUN_TS = ["  run() {", "    return this.io.start();", "  }", "}"];

test("TypeScript: the same forms leave the attribute unknown", (t) => {
  const cases = {
    B: ["  constructor() {", "    this.io = new Builder().build();", "  }"],
    G: ["  constructor() {", "    this.io = new Builder(", "    ).build();", "  }"],
    Or: ["  constructor(other: FakeIO) {", "    this.io = new RealIO() || other;", "  }"],
    Ternary: ["  constructor(live: boolean) {", "    this.io = live ? new RealIO() : new FakeIO();", "  }"],
    C: ["  constructor() {", "    this.io = new RealIO();", "  }", "  swap(other) {", "    [this.io, this.spare] = [other, null];", "  }"],
    D: ["  constructor() {", "    this.io = new RealIO();", "  }", "  flip(flag: boolean) {", "    if (flag) this.io = new FakeIO();", "  }"],
    Nullish: ["  constructor() {", "    this.io = new RealIO();", "  }", "  reset() {", "    this.io ??= new FakeIO();", "  }"],
    Field: ["  io = new Builder().build();"],
    Kept: ["  constructor() {", "    this.io = null;", "    this.io = new RealIO(); // the real one", "  }"],
  };
  const files = { "src/io.ts": TS_IO };
  for (const [name, body] of Object.entries(cases))
    files[`src/case-${name.toLowerCase()}.ts`] = lines('import { RealIO, FakeIO, Builder } from "./io";', `export class Case${name} {`, ...body, ...RUN_TS);
  const graph = build(t, files);
  for (const name of Object.keys(cases)) {
    const expected = name === "Kept" ? ["src/io.ts#RealIO.start"] : [];
    assert.deepEqual(calls(graph, `src/case-${name.toLowerCase()}.ts#Case${name}.run`), expected, name);
  }
});

// R2-3: a CRLF file reads the same as its LF copy (class-body fields too).
test("a CRLF file gives the same attribute edges as its LF copy", (t) => {
  const user = lines(
    "from app.io import RealIO",
    "",
    "class Field:",
    "    io: RealIO = RealIO()",
    "",
    "    def run(self):",
    "        return self.io.start()",
    "",
    "class Built:",
    "    def __init__(self):",
    "        self.io = RealIO()",
    "",
    "    def run(self):",
    "        return self.io.start()",
  );
  const edges = (text) => {
    const graph = build(t, { "app/__init__.py": "", "app/io.py": PY_IO.replaceAll("\n", text === "crlf" ? "\r\n" : "\n"), "app/user.py": text === "crlf" ? user.replaceAll("\n", "\r\n") : user });
    return ["Field", "Built"].map((owner) => calls(graph, `app/user.py#${owner}.run`));
  };
  const expected = [["app/io.py#RealIO.start"], ["app/io.py#RealIO.start"]];
  assert.deepEqual(edges("lf"), expected);
  assert.deepEqual(edges("crlf"), expected);
});

// R2-4: a member name the product defines nowhere stays member-nowhere, whatever the class extends.
test("an unassigned attribute's method that the product never defines stays member-nowhere", (t) => {
  const graph = build(t, {
    "app/__init__.py": "",
    "app/io.py": PY_IO,
    "app/win.py": lines("from app.io import RealIO", "", "class Win(RealIO):", "    def show(self):", "        self.button.setText(1)", "        return self.button.start()"),
  });
  assert.deepEqual(reasonOf(graph, "button.setText"), ["member-nowhere"]);
  assert.deepEqual(reasonOf(graph, "button.start"), ["inherited"]);
});

// R2-5: a constructor whose signature the scan cuts at 500 characters still gives its parameter types.
test("a typed parameter of a constructor with a signature over 500 characters is read from the file", (t) => {
  const many = Array.from({ length: 40 }, (_, index) => `        option_number_${index}: int = ${index},`);
  const graph = build(t, {
    "app/__init__.py": "",
    "app/io.py": PY_IO,
    "app/big.py": lines("from app.io import RealIO", "", "class Big:", "    def __init__(", "        self,", ...many, "        io: RealIO = None,", "    ):", "        self.io = io", "", "    def run(self):", "        return self.io.start()"),
  });
  assert.deepEqual(calls(graph, "app/big.py#Big.run"), ["app/io.py#RealIO.start"]);
});
