// Call precision (approved 2026-11-15): import layouts (가), members (마),
// value bindings (다), re-exports (라), built-in reasons (나) and functions
// held in a parameter or local (바). Fixtures are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";
import { analyzeSourceFile, extractSemanticSourceFacts, extractSourceSymbols } from "../scripts/lib/world/source-analysis.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures", "product-graph", "precision");

function temporary(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-call-precision-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// Builds a fixture product; rules is a rules document (object) or a file.
function build(t, source, rules = { schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: [] }) {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  let rulesFile = rules;
  if (typeof rules !== "string") {
    rulesFile = path.join(base, "rules.json");
    fs.writeFileSync(rulesFile, JSON.stringify(rules));
  }
  const result = buildProductGraph({
    sourceRoot: source,
    documentsDirectory: path.join(base, "documents"),
    rulesFile,
    outputDirectory: path.join(base, "out"),
  });
  const graph = JSON.parse(fs.readFileSync(path.join(base, "out", "graph.json"), "utf8"));
  const calls = graph.edges
    .filter((edge) => edge.type === "call")
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
  const reasons = Object.fromEntries(
    result.lists.unresolvedReferences.byReason
      .filter((reason) => reason.count)
      .map((reason) => [reason.reason, reason.callees.map((item) => item.callee).sort()]),
  );
  return { result, graph, calls, reasons, out: path.join(base, "out") };
}

const read = (file) => fs.readFileSync(path.join(fixtures, file), "utf8");

test("가: an import list gives the same bindings whatever its layout", () => {
  const layout = extractSemanticSourceFacts(read("imports/layout.mjs"), "javascript").bindings;
  const single = extractSemanticSourceFacts(read("imports/single.mjs"), "javascript").bindings;
  assert.deepEqual(layout, single);
  assert.deepEqual(
    layout.map((binding) => `${binding.local}<${binding.imported}${binding.namespace ? "*" : ""}`),
    [
      "Main<default",
      "Spread<default",
      "Whole<default",
      "alias<more",
      "everything<**",
      "extra<extra",
      "first<first",
      "fourth<fourth",
      "nameSpace<**",
      "other<second",
      "spreadAll<**",
      "third<third",
    ],
  );
});

test("마: class and object-literal members are declarations; a method definition is not a call", () => {
  const text = read("members/members.mjs");
  const symbols = extractSourceSymbols(text, "javascript", { maxSymbols: 1000 });
  assert.deepEqual(
    symbols.filter((symbol) => symbol.scopePath).map((symbol) => symbol.qualifiedName),
    [
      "Store.constructor",
      "Store.load",
      "Store.create",
      "Store.entries",
      "Store.size",
      "Store.size",
      "Store.#decode",
      "Store.save",
      "Store.count",
      "api.run",
      "api.stop",
      "api.go",
    ],
  );
  const calls = analyzeSourceFile(text, "javascript", "members.mjs").semanticFacts.calls.map((call) => call.callee);
  for (const definition of ["load", "create", "entries", "size", "save", "count", "run", "go", "constructor", "#decode", "decode"])
    assert(!calls.includes(definition), `${definition} is a definition, not a call`);
});

test("마: this.x, C.staticX, name.x and v = new C() resolve lexically; a reassigned variable and an inherited member do not", (t) => {
  const { calls, reasons } = build(t, path.join(fixtures, "members"));
  assert.deepEqual(calls, [
    "consumer.mjs#consume -> members.mjs#Store.create",
    "consumer.mjs#consume -> members.mjs#api.stop",
    "members.mjs#Store.create -> members.mjs#Store",
    "members.mjs#Store.load -> members.mjs#Store.#decode",
    "members.mjs#Store.save -> members.mjs#Store.count",
    "members.mjs#api.go -> members.mjs#helper",
    "members.mjs#api.run -> members.mjs#helper",
    "members.mjs#api.stop -> members.mjs#helper",
    "members.mjs#useAll -> members.mjs#Store",
    "members.mjs#useAll -> members.mjs#Store.create",
    "members.mjs#useAll -> members.mjs#Store.save",
    "members.mjs#useAll -> members.mjs#api.run",
    "members.py#Store.create -> members.py#Store",
    "members.py#Store.load -> members.py#Store.decode",
    "members.py#use_all -> members.py#Store",
    "members.py#use_all -> members.py#Store.create",
    "members.py#use_all -> members.py#Store.load",
  ]);
  assert.deepEqual(reasons, {
    keyword: ["super"],
    "unknown-receiver": ["later.count", "later.decode"],
    inherited: ["self.ping", "this.fetchRemote"],
  });
});

test("다: a called value binding is a 값 node; calls resolve to it and reach continues through its initialiser", (t) => {
  const { graph, calls, result } = build(t, path.join(fixtures, "values"), path.join(fixtures, "values", "rules.json"));
  const values = graph.nodes.filter((node) => node.kind === "값").map((node) => node.id);
  assert.deepEqual(values, ["values.mjs#fail"], "the binding nobody calls is not a node");
  assert(calls.includes("values.mjs#check -> values.mjs#fail"));
  assert(calls.includes("other.mjs#guard -> values.mjs#fail"));
  assert(calls.includes("values.mjs#fail -> errors.mjs#failWith"));
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(!unreached.includes("errors.mjs#failWith"), "reached only through check -> fail -> failWith");
  assert(!unreached.includes("values.mjs#fail"));
});

test("라: named, renamed, star, local-list and two-step re-exports resolve to the declaration; a cycle keeps its reason", (t) => {
  const { calls, reasons } = build(t, path.join(fixtures, "reexports"));
  assert.deepEqual(calls, [
    "use.mjs#run -> lib/impl.mjs#alpha",
    "use.mjs#run -> lib/impl.mjs#beta",
    "use.mjs#run -> lib/impl.mjs#delta",
    "use.mjs#run -> lib/star.mjs#starry",
  ]);
  assert.deepEqual(reasons, { rest: ["loop"] });
});

test("나: built-in calls get the three built-in reasons; a file's own or imported JSON does not; the numbers add up; a project rule adds a name", (t) => {
  const plain = build(t, path.join(fixtures, "builtins"));
  assert.deepEqual(plain.reasons, {
    "builtin-namespace": ["JSON.parse", "str.lower"],
    "builtin-global": ["String", "len", "setTimeout"],
    "member-nowhere": ["items.append", "items.map"],
    "no-declaration": ["customGlobal"],
  });
  assert(plain.calls.includes("own-json.mjs#readOwn -> own-json.mjs#JSON.parse"));
  assert(plain.calls.includes("imported-json.mjs#readImported -> codec.mjs#codec.parse"));
  const numbers = plain.result.limits.calls;
  assert.equal(numbers.notProduct.builtIn + numbers.notProduct.keyword + numbers.notProduct.external + numbers.canBeProduct, numbers.all);
  assert.equal(plain.result.lists.unresolvedReferences.byReason.reduce((sum, reason) => sum + reason.count, 0) + numbers.resolved, numbers.all);
  assert.match(plain.result.text, new RegExp(`제품 코드일 수 있는 호출 ${numbers.canBeProduct}개 중 ${numbers.resolved}개`));
  const extended = build(t, path.join(fixtures, "builtins"), {
    schemaVersion: 1,
    kind: "LodeProductGraphEntryRules",
    rules: [],
    "내장 이름": { javascript: { 함수: ["customGlobal"] } },
  });
  assert.deepEqual(extended.reasons["builtin-global"], ["String", "customGlobal", "len", "setTimeout"]);
  assert.equal(extended.reasons["no-declaration"], undefined);
});

test("나: in a product that declares its own map, x.map( stays under the unknown-receiver reason", (t) => {
  const base = temporary(t);
  const source = path.join(base, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "own-map.mjs"),
    "export function map(list) {\n  return list;\n}\n\nexport function use(items) {\n  return items.map(map);\n}\n",
  );
  const { reasons } = build(t, source);
  assert.deepEqual(reasons, { "unknown-receiver": ["items.map"] });
});

test("바: a function held in a parameter or local is counted under its own reason", (t) => {
  const { reasons, calls } = build(t, path.join(fixtures, "params"));
  assert.deepEqual(reasons, { "builtin-global": ["Promise"], "local-function": ["callback", "handler", "resolve"] });
  assert.deepEqual(calls, []);
});

const review = path.join(fixtures, "review");

test("class fields, class expressions and abstract signatures; product member names are never called built-in; new C() reaches the constructor", (t) => {
  const { calls, reasons, result } = build(t, path.join(review, "classes"), path.join(review, "classes", "rules.json"));
  assert.deepEqual(calls, [
    "classes.ts#Odd.onClick -> classes.ts#Odd.multi",
    "classes.ts#direct -> classes.ts#Store",
    "classes.ts#useAll -> classes.ts#Anonymous",
    "classes.ts#useAll -> classes.ts#Anonymous.run",
    "classes.ts#useAll -> classes.ts#Odd",
    "classes.ts#useAll -> classes.ts#Odd.onClick",
  ]);
  assert.deepEqual(reasons, {
    "builtin-global": ["Map"],
    "member-nowhere": ["thing.nothingDefinesThis"],
    "external-import": ["External"],
    "unknown-receiver": ["port.ping", "thing.legacyMethod", "thing.nested", "thing.quoted"],
    inherited: ["this.render"],
  });
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(!unreached.includes("classes.ts#Store.constructor"), "new Store(1) in a reached function reaches the constructor");
  assert(unreached.includes("classes.ts#Odd.multi"));
});

test("a default export is followed through re-export lists", (t) => {
  const { calls, reasons } = build(t, path.join(review, "defaults"));
  assert.deepEqual(calls, ["use.mjs#use -> lib/helper.mjs#helper", "use.mjs#use -> lib/run.mjs#run"]);
  assert.deepEqual(reasons, {});
});

test("Python: a parenthesised import list is read, print is a built-in function and cls() constructs the class", (t) => {
  const { calls, reasons } = build(t, path.join(review, "python"));
  assert.deepEqual(calls, [
    "models.py#Item.make -> models.py#Item",
    "models.py#make_item -> models.py#Item",
    "use.py#use -> models.py#Item",
    "use.py#use -> models.py#make_item",
  ]);
  assert.deepEqual(reasons["builtin-global"], ["print"]);
});

test("Lode itself: the reasons add up, every 값 node is called, and two builds are byte-identical", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const run = (name) =>
    buildProductGraph({
      sourceRoot: pluginRoot,
      documentsDirectory: path.join(base, "documents"),
      rulesFile: path.join(import.meta.dirname, "fixtures", "product-graph", "lode-entry-rules.json"),
      outputDirectory: path.join(base, name),
    });
  const result = run("first");
  run("second");
  for (const name of ["graph.json", "check.json", "check.txt"])
    assert.deepEqual(fs.readFileSync(path.join(base, "second", name)), fs.readFileSync(path.join(base, "first", name)), name);
  const numbers = result.limits.calls;
  assert.equal(numbers.notProduct.builtIn + numbers.notProduct.keyword + numbers.notProduct.external + numbers.canBeProduct, numbers.all);
  assert.equal(result.lists.unresolvedReferences.byReason.reduce((sum, reason) => sum + reason.count, 0) + numbers.resolved, numbers.all);
  const graph = JSON.parse(fs.readFileSync(path.join(base, "first", "graph.json"), "utf8"));
  const targets = new Set(graph.edges.filter((edge) => edge.type === "call").map((edge) => edge.to));
  for (const node of graph.nodes.filter((item) => item.kind === "값")) assert(targets.has(node.id), node.id);
});
