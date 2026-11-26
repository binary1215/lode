// Source analysis 0.3.4: a function's body is found after its parameter list
// closes, TypeScript return types are read past type literals, and a
// declaration without a body is one statement (synthetic sources only).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareExactSourceVersions } from "../scripts/lib/session/context-source-delta.mjs";
import {
  buildRepositoryScanInput,
  executeIncrementalRepositoryScan,
  scanRepositoryReference,
  validateRepositoryScanResult,
} from "../scripts/lib/world/repository-scan.mjs";
import { analyzeSourceFile, extractSemanticSourceFacts, extractSourceSymbols, SOURCE_ANALYSIS_VERSION } from "../scripts/lib/world/source-analysis.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();

function read(lines, language = "javascript") {
  const text = `${lines.join("\n")}\n`;
  return {
    symbols: extractSourceSymbols(text, language).map((s) => `${s.kind} ${s.qualifiedName} ${s.line}-${s.endLine} scope=${s.scopePath} [${s.signature}]`),
    calls: extractSemanticSourceFacts(text, language).calls.map((c) => `${c.callee}@${c.line}<-${c.callerQualifiedName ?? ""}`),
  };
}

test("a brace inside a parameter list is not the function's body", () => {
  const cases = [
    [["function f(a, options = {}) {", "  g();", "}"], ["function f 1-3 scope= [function f(a, options = {})]"], ["g@2<-f"]],
    [["function f({ a, b }) {", "  g();", "}"], ["function f 1-3 scope= [function f({ a, b })]"], ["g@2<-f"]],
    [["function f({ a } = {}, [b] = []) {", "  g();", "}"], ["function f 1-3 scope= [function f({ a } = {}, [b] = [])]"], ["g@2<-f"]],
    [["function f(", "  a,", "  { b } = {},", ") {", "  g();", "}"], ["function f 1-6 scope= [function f( a, { b } = {}, )]"], ["g@5<-f"]],
    [["async function* f({ a } = {}) {", "  yield g();", "}"], ["function f 1-3 scope= [async function* f({ a } = {})]"], ["g@2<-f"]],
    [["export default function f(options = {}) {", "  g();", "}"], ["function f 1-3 scope= [function f(options = {})]"], ["g@2<-f"]],
    [["const f = function ({ a }) {", "  g();", "};"], ["binding f 1-3 scope= [const f = function ({ a })]"], ["g@2<-f"]],
    [
      ["const f = async function inner(a = {}) {", "  g();", "};"],
      ["binding f 1-3 scope= [const f = async function inner(a = {})]", "function f.inner 1-3 scope=f [async function inner(a = {})]"],
      ["g@2<-f.inner"],
    ],
    [
      ["function outer(options = {}) {", "  function inner() {", "    g();", "  }", "  inner();", "}"],
      ["function outer 1-6 scope= [function outer(options = {})]", "function outer.inner 2-4 scope=outer [function inner()]"],
      ["g@3<-outer.inner", "inner@5<-outer"],
    ],
  ];
  for (const [lines, symbols, calls] of cases) assert.deepEqual(read(lines), { symbols, calls }, lines[0]);
});

test("TypeScript type parameters, return types and declarations without a body", () => {
  const cases = [
    [
      ["function f<T extends { a: string }>(x: T): Promise<{ a: string }> {", "  return g();", "}"],
      ["function f 1-3 scope= [function f<T extends { a: string }>(x: T): Promise<{ a: string }>]"],
      ["g@2<-f"],
    ],
    [["function f(): { a: string } {", "  return g();", "}"], ["function f 1-3 scope= [function f(): { a: string }]"], ["g@2<-f"]],
    [["function f(x: unknown): x is Foo {", "  return g();", "}"], ["function f 1-3 scope= [function f(x: unknown): x is Foo]"], ["g@2<-f"]],
    [
      ["function f(a: string): { a: string };", "function f(a: number): void;", "function f(a: any) {", "  g();", "}"],
      [
        "function f 1-1 scope= [function f(a: string): { a: string };]",
        "function f 2-2 scope= [function f(a: number): void;]",
        "function f 3-5 scope= [function f(a: any)]",
      ],
      ["g@4<-f"],
    ],
    [
      ["declare function f(): void", "function h(options = {}) {", "  g();", "}"],
      ["function f 1-1 scope= [function f(): void]", "function h 2-4 scope= [function h(options = {})]"],
      ["g@3<-h"],
    ],
    [
      ["class C {", "  load(): Promise<{ a: string }> {", "    return g();", "  }", "  get value(): { a: string } {", "    return h();", "  }", "}"],
      [
        "class C 1-8 scope= [class C]",
        "function C.load 2-4 scope=C [load(): Promise<{ a: string }>]",
        "function C.value 5-7 scope=C [get value(): { a: string }]",
      ],
      ["g@3<-C.load", "h@6<-C.value"],
    ],
  ];
  for (const [lines, symbols, calls] of cases) assert.deepEqual(read(lines, "typescript"), { symbols, calls }, lines[0]);
});

test("arrow bindings with defaults, callback types, return types and annotations", () => {
  const cases = [
    ["javascript", ["const f = (a = g()) => {", "  h();", "};"], ["binding f 1-3 scope= [const f = (a = g()) =>]"], ["g@1<-f", "h@2<-f"]],
    ["typescript", ["const f = (cb: () => void) => {", "  g();", "};"], ["binding f 1-3 scope= [const f = (cb: () => void) =>]"], ["g@2<-f"]],
    // "async (" is read as a call of async, as before 0.3.4.
    [
      "typescript",
      ["const f = async (a): Promise<void> => {", "  g();", "};"],
      ["binding f 1-3 scope= [const f = async (a): Promise<void> =>]"],
      ["async@1<-f", "g@2<-f"],
    ],
    ["typescript", ["const f: Handler = (a) => {", "  g();", "};"], ["binding f 1-3 scope= [const f: Handler = (a) =>]"], ["g@2<-f"]],
    ["typescript", ["const f = <T,>(a: T) => a", "g();"], ["binding f 1-1 scope= [const f = <T,>(a: T) => a]"], ["g@2<-"]],
    // An immediately invoked function keeps today's reading.
    [
      "javascript",
      ["const m = (() => { function inner() {} })()"],
      ["function m.inner 1-1 scope=m [function inner()]", "binding m 1-1 scope= [const m = (() =>]"],
      [],
    ],
  ];
  for (const [language, lines, symbols, calls] of cases) assert.deepEqual(read(lines, language), { symbols, calls }, lines[0]);
});

test("a ternary whose first branch is a call is neither a method nor a lost call (review F1)", () => {
  const cases = [
    [
      "javascript",
      ["const api = {", "  mode: flag ? pick(a) : fallback,", "  run() { work(); },", "};"],
      ["function api.run 3-3 scope=api [run()]"],
      ["pick@2<-", "work@3<-api.run"],
    ],
    [
      "javascript",
      ["class A {", "  value = flag ? pick(a) : other", "  run() {", "    work();", "  }", "}"],
      ["class A 1-6 scope= [class A]", "function A.run 3-5 scope=A [run()]"],
      ["pick@2<-", "work@4<-A.run"],
    ],
    [
      "javascript",
      ["const table = {", "  a: cond ? make(1) : null,", "  b: 2,", "  go() {", "    work();", "  },", "};"],
      ["function table.go 4-6 scope=table [go()]"],
      ["make@2<-", "work@5<-table.go"],
    ],
    [
      "javascript",
      ["function host() {", "  register(flag ? pick(a) : fallback, function () {", "    work();", "  });", "}"],
      ["function host 1-5 scope= [function host()]"],
      ["pick@2<-host", "register@2<-host", "work@3<-host"],
    ],
    [
      "typescript",
      ["function f() {", "  const x = flag ? pick(a) : b", "  try {", "    work();", "  } catch (e) {}", "}"],
      ["function f 1-6 scope= [function f()]"],
      ["pick@2<-f", "work@4<-f"],
    ],
    // Review F6: a function or class expression in the else branch is not a return type.
    [
      "javascript",
      ["function outer(c) {", "  const h = c ? pick(a) : function () {", "    work();", "  };", "}"],
      ["function outer 1-5 scope= [function outer(c)]"],
      ["pick@2<-outer", "work@3<-outer"],
    ],
    [
      "javascript",
      ["const api = {", "  key: flag ? pick(a) : function named() { work(); },", "  other: flag ? pick(b) : async function () { work(); },", "};"],
      ["function named 2-2 scope= [function named()]"],
      ["pick@2<-", "work@2<-named", "pick@3<-", "work@3<-"],
    ],
    [
      "javascript",
      ["function outer(c) {", "  const K = c ? pick(a) : class { m() {} };", "}"],
      ["function outer 1-3 scope= [function outer(c)]"],
      ["pick@2<-outer"],
    ],
  ];
  for (const [language, lines, symbols, calls] of cases) assert.deepEqual(read(lines, language), { symbols, calls }, lines[1]);
});

test("an annotation without an initializer never borrows a later '=' (review F2)", () => {
  const cases = [
    [
      ["let cache: Map<string, number>", "const load = async (id: string) => {", "  return fetchIt(id)", "}"],
      ["binding load 2-4 scope= [const load = async (id: string) =>]"],
      ["async@2<-load", "fetchIt@3<-load"],
    ],
    [["let count: number", "thing.handler = (a) => {", "  work(a);", "};"], [], ["work@3<-"]],
    [["let a: number, b = (x) => {", "  work(x);", "};"], [], ["work@2<-"]],
    [["const f: (a: number) => void = (a) => {", "  work(a);", "};"], ["binding f 1-3 scope= [const f: (a: number) => void = (a) =>]"], ["work@2<-f"]],
  ];
  for (const [lines, symbols, calls] of cases) assert.deepEqual(read(lines, "typescript"), { symbols, calls }, lines[0]);
});

test("return types: conditional types, unions and predicates over several lines (review F3)", () => {
  const cases = [
    [
      ["function pick<T>(x: T): T extends string ? { s: string } : { n: number } {", "  return work(x);", "}"],
      ["function pick 1-3 scope= [function pick<T>(x: T): T extends string ? { s: string } : { n: number }]"],
      ["work@2<-pick"],
    ],
    [["function f(): A |", "  B {", "  return work();", "}"], ["function f 1-4 scope= [function f(): A | B]"], ["work@3<-f"]],
    [
      ["function f():", "  | { a: string }", "  | null {", "  return work();", "}"],
      ["function f 1-5 scope= [function f(): | { a: string } | null]"],
      ["work@4<-f"],
    ],
    [
      ["function f(x: unknown): asserts x is", "  Foo {", "  work();", "}"],
      ["function f 1-4 scope= [function f(x: unknown): asserts x is Foo]"],
      ["work@3<-f"],
    ],
  ];
  for (const [lines, symbols, calls] of cases) assert.deepEqual(read(lines, "typescript"), { symbols, calls }, lines[0]);
});

test("an import type is a type in function, method and arrow return types (review F8)", () => {
  const lines = [
    'export function load(id: string): import("./types").Loaded {',
    "  return read(id);",
    "}",
    'export function direct(): typeof import("./x") {',
    "  return load();",
    "}",
    "class Store {",
    '  get(): import("./types").Loaded {',
    "    return fetchIt();",
    "  }",
    "}",
    'const arrow = (a): import("./types").Loaded => {',
    "  return pull(a);",
    "};",
  ];
  assert.deepEqual(read(lines, "typescript"), {
    symbols: [
      'function load 1-3 scope= [export function load(id: string): import("./types").Loaded]',
      'function direct 4-6 scope= [export function direct(): typeof import("./x")]',
      "class Store 7-11 scope= [class Store]",
      'function Store.get 8-10 scope=Store [get(): import("./types").Loaded]',
      'binding arrow 12-14 scope= [const arrow = (a): import("./types").Loaded =>]',
    ],
    // "import(" is read as a call, as before 0.3.4.
    calls: [
      "import@1<-load",
      "read@2<-load",
      "import@4<-direct",
      "load@5<-direct",
      "import@8<-Store.get",
      "fetchIt@9<-Store.get",
      "import@12<-arrow",
      "pull@13<-arrow",
    ],
  });
  // A template's blanked text between ")" and "{" is still no method definition.
  assert.deepEqual(read(["const s = `${f()} ${ {a} }`;"]), { symbols: [], calls: ["f@1<-"] });
});

test("declarations starting on one line nest by offsets, not by lines (Go parity)", () => {
  assert.deepEqual(
    read([
      "function oneLine() { function innerOne() { first(); } innerOne(); }",
      "const wrap = (x) => function wrapped() { return first(x); };",
      "function twoA() { first(); } function twoB() { first(); }",
      "const holder = { run: function () { first(); } };",
      "class OneLine { go() { first(); } }",
      "const arrowInArrow = () => () => first();",
      "const both = function left() { first(); }, right = () => first();",
    ]),
    {
      symbols: [
        "function oneLine.innerOne 1-1 scope=oneLine [function innerOne()]",
        "function oneLine 1-1 scope= [function oneLine()]",
        "binding wrap 2-2 scope= [const wrap = (x) => function wrapped() { return first(x);]",
        "function wrapped 2-2 scope= [function wrapped()]",
        "function twoA 3-3 scope= [function twoA()]",
        "function twoB 3-3 scope= [function twoB()]",
        "function holder.run 4-4 scope=holder [run: function ()]",
        "class OneLine 5-5 scope= [class OneLine]",
        "function OneLine.go 5-5 scope=OneLine [go()]",
        "binding arrowInArrow 6-6 scope= [const arrowInArrow = () => () => first();]",
        "binding both 7-7 scope= [const both = function left()]",
        "function both.left 7-7 scope=both [function left()]",
      ],
      calls: [
        "first@1<-oneLine.innerOne",
        "innerOne@1<-oneLine",
        "first@2<-wrapped",
        "first@3<-twoA",
        "first@3<-twoB",
        "first@4<-holder.run",
        "first@5<-OneLine.go",
        "first@6<-arrowInArrow",
        "first@7<-both.left",
        "first@7<-",
      ],
    },
  );
  assert.deepEqual(
    read(
      [
        "function oneLineTs(): void { function innerTs(): number { return first(); } innerTs(); }",
        'const namedTs = async function innerNamed(a: { b: string } = { b: "" }): Promise<void> { first(a); };',
        "function twoTsA(): { a: string } { return first(); } function twoTsB(x: number): void { first(x); }",
      ],
      "typescript",
    ),
    {
      symbols: [
        "function oneLineTs.innerTs 1-1 scope=oneLineTs [function innerTs(): number]",
        "function oneLineTs 1-1 scope= [function oneLineTs(): void]",
        'function namedTs.innerNamed 2-2 scope=namedTs [async function innerNamed(a: { b: string } = { b: "" }): Promise<void>]',
        'binding namedTs 2-2 scope= [const namedTs = async function innerNamed(a: { b: string } = { b: "" }): Promise<void>]',
        "function twoTsA 3-3 scope= [function twoTsA(): { a: string }]",
        "function twoTsB 3-3 scope= [function twoTsB(x: number): void]",
      ],
      calls: ["first@1<-oneLineTs.innerTs", "innerTs@1<-oneLineTs", "first@2<-namedTs.innerNamed", "first@3<-twoTsA", "first@3<-twoTsB"],
    },
  );
});

test("a parameter list that does not close keeps the old reading and is counted", () => {
  const text = "function broken(a = {} {\n  g();\n}\n";
  const result = analyzeSourceFile(text, "javascript", "broken.js", { withMaskedText: true });
  assert.equal(result.rangeFallbacks, 1);
  assert.ok(result.bracketPartners instanceof Int32Array);
  assert.equal(analyzeSourceFile("function fine(a = {}) {}\n", "javascript", "fine.js", { withMaskedText: true }).rangeFallbacks, 0);
  // Not part of a stored scan.
  assert.equal("rangeFallbacks" in analyzeSourceFile(text, "javascript", "broken.js"), false);
});

test("Lode's own dispatch reads its body and calls the session dispatcher", () => {
  const text = fs.readFileSync(path.join(pluginRoot, "scripts", "mcp-server.mjs"), "utf8");
  const dispatch = extractSourceSymbols(text, "javascript").find((symbol) => symbol.qualifiedName === "dispatch");
  const close = text.split("\n").findIndex((line, index) => index >= dispatch.line && line === "}");
  assert.equal(dispatch.endLine, close + 1);
  assert.ok(dispatch.endLine > dispatch.line + 3);
  const calls = extractSemanticSourceFacts(text, "javascript").calls.filter((call) => call.callerQualifiedName === "dispatch");
  assert.ok(calls.some((call) => call.callee === "dispatchSessionRequest"));
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function reidentifyScan(payload) {
  const scanHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
  return { ...payload, scanId: `repository-scan-${scanHash.slice(0, 24)}`, scanHash };
}

test("a stored 0.3.3 scan is read and scanned again, not reused", async (t) => {
  assert.equal(SOURCE_ANALYSIS_VERSION, "0.3.4");
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(testParent, "lode-scan-033-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "app.js"), "export function run(options = {}) {\n  return step(options);\n}\nfunction step() {}\n");
  const current = scanRepositoryReference(buildRepositoryScanInput({ projectRoot: root }));
  // The 0.3.3 reading of the same file: a one-line range for run.
  const payload = structuredClone(current);
  delete payload.scanId;
  delete payload.scanHash;
  payload.sourceAnalysisVersion = "0.3.3";
  const run = payload.files[0].symbols.find((symbol) => symbol.name === "run");
  run.endLine = 1;
  const stored = reidentifyScan(payload);
  assert.doesNotThrow(() => validateRepositoryScanResult(stored));
  const { files, skipped, ...repositoryScan } = stored;
  const rescanned = await executeIncrementalRepositoryScan({ projectRoot: root, previousSnapshot: { repositoryScan, files, skipped } });
  assert.deepEqual(rescanned.diagnostics.reusedPaths, []);
  assert.deepEqual(rescanned.diagnostics.analyzedPaths, ["app.js"]);
  assert.equal(rescanned.result.sourceAnalysisVersion, "0.3.4");
  assert.equal(rescanned.result.files[0].symbols.find((symbol) => symbol.name === "run").endLine, 3);
});

test("a change inside a body with a default object parameter is attributed to the function", () => {
  const before = "export function f(a, options = {}) {\n  return a + 1;\n}\nexport function g() {\n  return 2;\n}\n";
  const after = before.replace("a + 1", "a + 2");
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const version = (text) => ({ text, digest: sha(text), path: "src/f.mjs", projectId: "synthetic-project", basis: { kind: "synthetic-exact-version" } });
  const result = compareExactSourceVersions(version(before), version(after), "synthetic-project");
  const observation = (name) => result.symbols.find((item) => (item.after || item.before).qualifiedName === name);
  assert.equal(observation("f").observation, "declaration-bytes-changed");
  assert.deepEqual([observation("f").after.line, observation("f").after.endLine], [1, 3]);
  assert.equal(observation("g").observation, "declaration-bytes-unchanged");
});
