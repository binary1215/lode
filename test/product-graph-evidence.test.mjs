// Product graph: reach precision, evidence from runs and outside-facing nodes
// (the bundle after 0.3.0-beta.133). Every product here is synthetic, except
// the checks on Lode's own source.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { fixture, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import { registryCatalog, OPERATIONS } from "../scripts/lib/session/operation-registry.mjs";
import { productGraphWalk as walk } from "../scripts/graph-explorer/product-graph-walk.js";

const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
const RULES_HEAD = { schemaVersion: 1, kind: "LodeProductGraphEntryRules" };

function temporary(t, prefix = "lode-product-graph-evidence-") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// A synthetic product built stand-alone with its own rule table. build()
// writes a fresh output folder each time; ask() queries the last one.
function product(t, files, rules = {}) {
  const base = temporary(t);
  const source = path.join(base, "source");
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), text);
  };
  for (const [name, text] of Object.entries(files)) write(name, text);
  fs.mkdirSync(path.join(base, "documents"));
  const rulesFile = path.join(base, "rules.json");
  const setRules = (value) => fs.writeFileSync(rulesFile, JSON.stringify({ ...RULES_HEAD, rules: [], ...value }, null, 2));
  setRules(rules);
  let run = 0;
  let out = null;
  const build = () => {
    out = path.join(base, `out-${(run += 1)}`);
    const result = buildProductGraph({ sourceRoot: source, documentsDirectory: path.join(base, "documents"), rulesFile, outputDirectory: out });
    const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
    return { result, graph, out };
  };
  const ask = (request) => queryProductGraph({ buildDirectory: out, ...request });
  return { base, source, write, setRules, build, ask };
}

const lines = (...items) => `${items.join("\n")}\n`;
const reachOf = (graph, id) => walk.reachOf(walk.index(graph), [id]);

// ---------- 2.1 entry code (입구) ----------

const TOOLS = {
  "src/registry.js": lines(
    'import { save, load } from "./tools.js";',
    "export const TOOLS = [",
    '  { name: "save", run: save },',
    '  { name: "load", run: load },',
    "];",
  ),
  "src/tools.js": lines("export function save() { return write(); }", "export function load() { return read(); }", "function write() { return 1; }", "function read() { return 2; }"),
  "src/server.js": lines(
    'import { save, load } from "./tools.js";',
    "export function route(name) {",
    "  guard(name);",
    '  if (name === "save") return save();',
    "  return load();",
    "}",
    "function guard(name) { return Boolean(name); }",
    "export function unused() { return 3; }",
  ),
};
const toolRule = (extra = {}) => ({ 종류: "tool", 판단: true, 파일: ["src/registry.js"], 패턴: 'name: "(\\w+)"', "처리 코드": "항목", ...extra });

test("2.1: 입구 gives a 기능→코드 edge with 역할 입구, reach starts from both roles and stops at another 기능's 처리 코드", (t) => {
  const p = product(t, TOOLS, { rules: [toolRule({ 입구: ["src/server.js#route"] })] });
  const { result, graph } = p.build();
  const roles = graph.edges.filter((edge) => edge.type === "기능→코드" && edge.from === "tool:save").map((edge) => [edge.to, edge.역할]);
  assert.deepEqual(roles.sort(), [
    ["src/server.js#route", "입구"],
    ["src/tools.js#save", "처리"],
  ]);
  const reached = reachOf(graph, "tool:save");
  assert.equal(reached.get("src/tools.js#save"), "처리");
  assert.equal(reached.get("src/tools.js#write"), "처리");
  assert.equal(reached.get("src/server.js#route"), "입구");
  assert.equal(reached.get("src/server.js#guard"), "입구");
  // route calls load(), tool:load's 처리 코드: not entered from tool:save's 입구.
  assert.equal(reached.has("src/tools.js#load"), false);
  assert.equal(reached.has("src/tools.js#read"), false);
  // The unreached-code list: code reached only through 입구 is reached.
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(!unreached.includes("src/server.js#guard"));
  assert(unreached.includes("src/server.js#unused"));
  // The reach answer says through which role, in text and in data.
  p.ask({ question: "overview" });
  const down = p.ask({ question: "reach", id: "tool:save" });
  const guard = down.rows.find((row) => row.id === "src/server.js#guard");
  assert.equal(guard.via, "입구");
  assert.match(guard.text, / — 입구로 닿음$/);
  const write = down.rows.find((row) => row.id === "src/tools.js#write");
  assert.equal(write.via, "처리");
  assert.doesNotMatch(write.text, /입구/);
  assert.deepEqual(down.reach.via["src/server.js#guard"], "입구");
  // reach <code> marks the 기능 that reach it only through 입구.
  const up = p.ask({ question: "reach", id: "src/server.js#guard" });
  assert.deepEqual(up.reach.ids, ["tool:load", "tool:save"]);
  for (const id of up.reach.ids) {
    const row = up.rows.find((item) => item.id === id);
    assert.equal(row.via, "입구");
    assert.match(row.text, / — 입구로만 닿음$/);
  }
  const own = p.ask({ question: "reach", id: "src/tools.js#write" });
  assert.deepEqual(own.reach.ids, ["tool:save"]);
  assert.equal(own.rows.find((row) => row.id === "tool:save").via, "처리");
  // A 기능's child rows name the role.
  const children = p.ask({ question: "down", id: "tool:save" });
  const entryRow = children.rows.find((row) => row.id === "src/server.js#route");
  assert.equal(entryRow.역할, "입구");
  assert.match(entryRow.text, /\(입구\)/);
  assert.equal(children.rows.find((row) => row.id === "src/tools.js#save").역할, "처리");
  // The reach hash covers the code reached through 입구.
  const node = graph.nodes.find((item) => item.id === "tool:save");
  assert.ok(node.reachSha256);
});

test("2.1: a kind-only rule's 입구 applies to every 기능 of that kind; a code ID that is not a node is a listed rule issue", (t) => {
  const p = product(t, TOOLS, {
    rules: [toolRule(), { 종류: "tool", 판단: true, 입구: ["src/server.js#route", "src/server.js#gone"] }],
  });
  const { result, graph } = p.build();
  for (const id of ["tool:save", "tool:load"]) assert.equal(reachOf(graph, id).get("src/server.js#route"), "입구", id);
  assert.deepEqual(
    result.lists.ruleIssues.map((item) => [item.종류, item.path, item.reason]),
    [["tool", "src/server.js#gone", "규칙이 가리키는 코드가 없음"]],
  );
  assert.match(result.text, /호출 방식 표 문제: 1개\n {2}- tool: src\/server\.js#gone — 규칙이 가리키는 코드가 없음/);
  // Code that is already the 기능's 처리 코드 keeps that role.
  const q = product(t, TOOLS, { rules: [toolRule({ 입구: ["src/tools.js#save"] })] });
  const own = q.build().graph.edges.filter((edge) => edge.type === "기능→코드" && edge.from === "tool:save");
  assert.deepEqual(
    own.map((edge) => [edge.to, edge.역할]),
    [["src/tools.js#save", "처리"]],
  );
});

test("2.1: without 입구 a build reads as before: every 기능→코드 edge is 처리 and no answer names 입구", (t) => {
  const p = product(t, TOOLS, { rules: [toolRule()] });
  const { result, graph } = p.build();
  assert(graph.edges.filter((edge) => edge.type === "기능→코드").every((edge) => edge.역할 === "처리"));
  assert.doesNotMatch(result.text, /입구/);
  const reached = reachOf(graph, "tool:save");
  assert([...reached.values()].every((via) => via === "처리"));
  assert.equal(reached.has("src/server.js#route"), false);
  p.ask({ question: "overview" });
  for (const request of [
    { question: "reach", id: "tool:save" },
    { question: "reach", id: "src/tools.js#write" },
    { question: "down", id: "tool:save" },
  ]) {
    const answer = p.ask(request);
    assert.doesNotMatch(answer.text, /입구/, JSON.stringify(request));
  }
  // The 기능's stated content has no entries field without 입구.
  const node = graph.nodes.find((item) => item.id === "tool:save");
  const withEntries = product(t, TOOLS, { rules: [toolRule({ 입구: ["src/server.js#route"] })] });
  const other = withEntries.build().graph.nodes.find((item) => item.id === "tool:save");
  assert.notEqual(node.contentSha256, other.contentSha256);
});

test("2.1 on Lode itself: every registry tool: and cli: 기능 reaches its dispatcher through 입구; a 기능 of another kind does not", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const out = path.join(base, "out");
  buildProductGraph({
    sourceRoot: pluginRoot,
    documentsDirectory: path.join(base, "documents"),
    rulesFile: path.join(fixtures, "lode-entry-rules.json"),
    outputDirectory: out,
  });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  const ix = walk.index(graph);
  const registered = [
    ...registryCatalog().map((tool) => ["tool", `tool:${tool.name}`]),
    ...OPERATIONS.filter((entry) => entry.cli)
      .flatMap((entry) => [entry.cli.command, ...(entry.cli.aliases ?? [])])
      .map((name) => ["cli", `cli:${name}`]),
  ];
  const dispatcher = { tool: "scripts/mcp-server.mjs#dispatch", cli: "scripts/lode.mjs#runCommand" };
  for (const [kind, id] of registered) {
    const reached = walk.reachOf(ix, [id]);
    assert(reached.has(dispatcher[kind]), `${id} reaches ${dispatcher[kind]}`);
  }
  const others = (ix.byType.get("기능") || []).filter((node) => !/^(tool|cli):/.test(node.id));
  assert(others.length > 0);
  for (const node of others) {
    const reached = walk.reachOf(ix, [node.id]);
    assert(!reached.has(dispatcher.tool) && !reached.has(dispatcher.cli), node.id);
  }
});

// ---------- 2.2 run by path (framework-invoked) ----------

const RUNNER = {
  "src/main.js": lines(
    'import path from "node:path";',
    'import { helper } from "./helper.js";',
    'import "./side.js";',
    "export function start(spawn, root) {",
    '  spawn(process.execPath, [path.join(root, "worker.js")]);',
    "  spawn(process.execPath, [`${root}/src/jobs/nightly.mjs`]);",
    "  // spawn(process.execPath, [\"quiet.js\"]) is only a comment",
    '  spawn(process.execPath, ["util.js"]);',
    '  const text = readFileSync(path.join(root, "quiet.js"), "utf8");',
    '  const names = ["src/helper.js", "worker.js"];',
    '  return helper("main.js") + text + names;',
    "}",
  ),
  "src/helper.js": lines("export function helper(name) { return name; }"),
  "src/side.js": lines("setUp();", "function setUp() { return 1; }"),
  "src/worker.js": lines("main();", "function main() { return work(); }", "function work() { return 2; }"),
  "src/jobs/nightly.mjs": lines("run();", "function run() { return 3; }"),
  "src/quiet.js": lines("export function hush() { return 4; }"),
  "src/a/util.js": lines("export function one() { return 5; }"),
  "src/b/util.js": lines("export function two() { return 6; }"),
};
const startRule = { rules: [{ 종류: "cli", 판단: true, 파일: ["src/main.js"], 패턴: "export function (start)", "처리 코드": "줄을 감싼 코드" }] };

test("2.2: a literal ending with one code file's path and a bare import give framework-invoked; reach follows them; every site is listed", (t) => {
  const p = product(t, RUNNER, startRule);
  const { result, graph } = p.build();
  const edges = graph.edges.filter((edge) => edge.type === "framework-invoked").map((edge) => [edge.from, edge.to, edge.at.line]);
  assert.deepEqual(
    edges.sort((x, y) => x[2] - y[2]),
    [
      ["src/main.js", "src/side.js", 3],
      ["src/main.js#start", "src/worker.js", 5],
      ["src/main.js#start", "src/jobs/nightly.mjs", 6],
    ],
  );
  const reached = reachOf(graph, "cli:start");
  for (const id of ["src/worker.js", "src/worker.js#main", "src/worker.js#work", "src/jobs/nightly.mjs#run"]) assert(reached.has(id), id);
  // Not the file only a comment names or a read of a file (quiet.js), not a
  // list that names files, not "main.js" (the file itself), not an import specifier.
  assert(!graph.edges.some((edge) => edge.type === "framework-invoked" && ["src/quiet.js", "src/helper.js"].includes(edge.to)));
  assert.equal(result.lists.runByPath.sites.filter((site) => site.to === "src/worker.js").length, 1);
  // Two files end with util.js: no edge, one count.
  assert(!graph.edges.some((edge) => edge.type === "framework-invoked" && edge.to.endsWith("util.js")));
  assert.equal(result.lists.runByPath.ambiguous, 1);
  assert.deepEqual(
    result.lists.runByPath.sites.map((site) => [site.path, site.line, site.from, site.to, site.shape]),
    [
      ["src/main.js", 3, "src/main.js", "src/side.js", "bare-import"],
      ["src/main.js", 5, "src/main.js#start", "src/worker.js", "path"],
      ["src/main.js", 6, "src/main.js#start", "src/jobs/nightly.mjs", "path"],
    ],
  );
  assert.match(result.text, /\n경로로 실행으로 읽은 곳: 3곳 \([^\n]*\) — 경로가 여러 파일에 맞음 1곳은 잇지 않았다\n {2}- src\/main\.js:3 src\/main\.js → src\/side\.js — "\.\/side\.js"\n/);
  assert(result.limits.referenceKinds.emitted.includes("framework-invoked"));
  assert(!result.limits.referenceKinds.notToldApart.includes("framework-invoked"));
  assert.match(result.text, /- framework-invoked는 두 모양만 읽는다: [^\n]*주입, 데코레이터, 파일 이름으로 정하는 경로는 보지 못한다/);
  // The answers name the kind they follow.
  p.ask({ question: "overview" });
  const answer = p.ask({ question: "reach", id: "cli:start" });
  assert.match(answer.header[1], /풀린 call·callback·framework-invoked만 따라간다/);
});

test("2.2: with no path literal nothing changes: no edge, no list, the header names call and callback only", (t) => {
  const p = product(t, { "src/main.js": lines("export function start() { return helper(); }", "function helper() { return 1; }") }, startRule);
  const { result, graph } = p.build();
  assert(!graph.edges.some((edge) => edge.type === "framework-invoked"));
  assert.deepEqual(result.lists.runByPath, { sites: [], ambiguous: 0 });
  assert.doesNotMatch(result.text, /\n경로로 실행으로 읽은 곳: /);
  p.ask({ question: "overview" });
  assert.match(p.ask({ question: "reach", id: "cli:start" }).header[1], /풀린 call·callback만 따라간다/);
});

// ---------- 2.3 a function used as a value (callback) ----------

const VALUES = {
  "src/main.js": lines(
    'import { onSave, Store } from "./lib.js";',
    'import * as tools from "./tools.js";',
    "const table = { run: tools.go };",
    "export function start(list, emitter, handler) {",
    "  list.map(format);",
    '  emitter.on("save", onSave);',
    "  const pair = { stop, Store };",
    "  handler(list);",
    "  return [pair, table, Store.make, helpers.pick];",
    "}",
    "function format(item) { return item; }",
    "function stop() { return 0; }",
    "const helpers = { pick() { return 1; } };",
    "export class Panel {",
    "  open() { return this.render; }",
    "  render() { return 2; }",
    "}",
    "export function unused() { return format; }",
  ),
  "src/lib.js": lines("export function onSave() { return 3; }", "export class Store {", "  static make() { return new Store(); }", "  fill() { return 4; }", "}"),
  "src/tools.js": lines("export function go() { return 5; }"),
};

test("2.3: names and members used as values give callback references by the call rules; parameters and declarations do not", (t) => {
  const p = product(t, VALUES, startRule);
  const { result, graph } = p.build();
  const values = graph.edges.filter((edge) => edge.type === "callback").map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(values.sort(), [
    "src/main.js -> src/tools.js#go",
    "src/main.js#Panel.open -> src/main.js#Panel.render",
    "src/main.js#start -> src/lib.js#Store",
    "src/main.js#start -> src/lib.js#Store.make",
    "src/main.js#start -> src/lib.js#onSave",
    "src/main.js#start -> src/main.js#format",
    "src/main.js#start -> src/main.js#helpers.pick",
    "src/main.js#start -> src/main.js#stop",
    "src/main.js#unused -> src/main.js#format",
  ]);
  // A call keeps its meaning: start calls handler (a parameter), unresolved.
  assert(!graph.edges.some((edge) => edge.type === "call" && edge.from === "src/main.js#start"));
  const reached = reachOf(graph, "cli:start");
  for (const id of ["src/main.js#format", "src/main.js#stop", "src/lib.js#onSave", "src/lib.js#Store.make"]) assert(reached.has(id), id);
  assert.deepEqual(result.limits.valueUses.sites, 9);
  assert.equal(result.limits.valueUses.plain + result.limits.valueUses.members, 9);
  assert.match(result.text, /\n- 값으로 쓴 함수 9곳\(이름 \d+, 멤버 \d+\)\. 호출 수와 따로 센다\. /);
  assert.equal(result.limits.calls.resolved, result.referenceSummary.resolvedCalls);
});

test("2.3: a name held in a parameter or local, a TypeScript type position and a string are not value uses; nothing configured reads as before", (t) => {
  const p = product(t, {
    "src/main.ts": lines(
      "export function start(format: Formatter, items: Item[]) {",
      "  const local = items;",
      '  return [local, format, "pick"];',
      "}",
      "export class Formatter { run() { return 1; } }",
      "export class Item {}",
      "function pick() { return 2; }",
    ),
  });
  const { graph, result } = p.build();
  assert(!graph.edges.some((edge) => edge.type === "callback"));
  assert.equal(result.limits.valueUses.sites, 0);
  assert.match(result.text, /\n- 값으로 쓴 함수 0곳\(이름 0, 멤버 0\)\./);
});

// ---------- 2.4 connections written by hand ----------

const HANDS = {
  "src/server.js": lines(
    'import { spawnSync } from "node:child_process";',
    "export function call(handlers, name) {",
    "  return handlers[name](name);",
    "}",
    "export function delegate(name) {",
    '  return spawnSync(process.execPath, [WORKER, name]);',
    "}",
    'const WORKER = "worker";',
  ),
  "src/tools.js": lines("export function save() { return deep(); }", "export function load() { return 1; }", "function deep() { return 2; }"),
  "src/worker.js": lines("export function work() { return heavy(); }", "function heavy() { return 3; }"),
};
const handRules = (extra = []) => ({
  rules: [
    { 종류: "cli", 판단: true, 파일: ["src/server.js"], 패턴: "export function (call|delegate)", "처리 코드": "줄을 감싼 코드" },
  ],
  "손으로 적는 연결": [
    { 판단: true, 종류: "framework-invoked", 파일: "src/server.js", 글: "handlers[name](", 대상: ["src/tools.js#save", "src/tools.js#load"], 설명: "the server calls a tool by its name" },
    { 판단: true, 종류: "경계", 파일: "src/server.js", 글: "spawnSync(process.execPath, [WORKER", 대상: ["src/worker.js#work"], 설명: "another process; not followed" },
    ...extra,
  ],
});

test("2.4: a hand-written framework-invoked is a judged reference reach follows; a boundary stops reach and says what lies behind it", (t) => {
  const p = product(t, HANDS, handRules());
  const { result, graph } = p.build();
  const judged = graph.edges.filter((edge) => edge.judgement).map((edge) => [edge.type, edge.from, edge.to, edge.at.line]);
  assert.deepEqual(judged, [
    ["framework-invoked", "src/server.js#call", "src/tools.js#load", 3],
    ["framework-invoked", "src/server.js#call", "src/tools.js#save", 3],
    ["경계", "src/server.js#delegate", "src/worker.js#work", 6],
  ]);
  const call = reachOf(graph, "cli:call");
  for (const id of ["src/tools.js#save", "src/tools.js#deep", "src/tools.js#load"]) assert(call.has(id), id);
  const delegate = reachOf(graph, "cli:delegate");
  assert(!delegate.has("src/worker.js#work") && !delegate.has("src/worker.js#heavy"));
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(unreached.includes("src/worker.js#work") && unreached.includes("src/worker.js#heavy"));
  assert(!unreached.includes("src/tools.js#deep"));
  assert.deepEqual(result.lists.ruleIssues, []);
  p.ask({ question: "overview" });
  // The judged edge prints (판단); the boundary prints under its node.
  const down = p.ask({ question: "down", id: "src/server.js#call" });
  const save = down.rows.find((row) => row.id === "src/tools.js#save");
  assert.match(save.text, /\(판단\)/);
  assert.equal(save.judgement, true);
  const node = p.ask({ question: "node", id: "src/server.js#delegate" });
  assert(node.rows.some((row) => row.text === "경계에서 멈춤: another process; not followed → src/worker.js#work" && row.boundary.to === "src/worker.js#work"));
  const reachDown = p.ask({ question: "reach", id: "cli:delegate" });
  const stop = reachDown.rows.find((row) => row.boundary);
  assert.equal(stop.text, "경계에서 멈춤: another process; not followed → src/worker.js#work");
  // reach <code> behind the boundary: which 기능 a crossed boundary would add.
  const behind = p.ask({ question: "reach", id: "src/worker.js#heavy" });
  assert.deepEqual(behind.reach.ids, []);
  assert.deepEqual(behind.reach.acrossBoundary, [{ from: "src/server.js#delegate", to: "src/worker.js#work", 설명: "another process; not followed", functions: ["cli:delegate"] }]);
  assert(behind.text.includes("경계를 넘으면 닿는 기능 1개 (src/server.js#delegate의 경계 → src/worker.js#work: another process; not followed): cli:delegate"));
});

test("2.4: 글 on no line, a missing file and a 대상 that is not a node are 규칙이 낡음 issues; no rule reads as before", (t) => {
  const p = product(
    t,
    HANDS,
    handRules([
      { 판단: true, 종류: "framework-invoked", 파일: "src/server.js", 글: "nowhere(", 대상: ["src/tools.js#save"] },
      { 판단: true, 종류: "경계", 파일: "src/gone.js", 글: "x", 대상: ["src/worker.js#work"] },
      { 판단: true, 종류: "framework-invoked", 파일: "src/server.js", 글: "handlers[name](", 대상: ["src/tools.js#nothing"] },
    ]),
  );
  const { result } = p.build();
  assert.deepEqual(
    result.lists.ruleIssues.map((item) => [item.rule, item.path, item.reason]),
    [
      [2, "src/server.js", '규칙이 낡음 — 글 "nowhere("이 코드 줄에 없음'],
      [3, "src/gone.js", "규칙이 낡음 — 파일이 스캔한 코드에 없음"],
      [4, "src/server.js", "규칙이 낡음 — 대상 src/tools.js#nothing이 코드 노드가 아님"],
    ],
  );
  assert.match(result.text, /호출 방식 표 문제: 3개/);
  // Without the rules: no judged edge, no boundary, nothing printed.
  const q = product(t, HANDS, { rules: handRules().rules });
  const plain = q.build();
  assert(!plain.graph.edges.some((edge) => edge.judgement || edge.type === "경계"));
  assert.doesNotMatch(plain.result.text, /\(판단\)|경계에서 멈춤|경계를 넘으면/);
  // The rule table refuses a hand-written rule that is not judged.
  const r = product(t, HANDS, { ...handRules(), "손으로 적는 연결": [{ 종류: "경계", 파일: "src/server.js", 글: "x", 대상: ["src/worker.js#work"] }] });
  assert.throws(() => r.build(), { code: "PRODUCT_GRAPH_RULES_INVALID" });
});

// ---------- 2.5 sample, tree and user ----------

test("2.5: the sample is seeded, spread over the edge types present, prints both ends and their evidence, and stores nothing", async (t) => {
  const { sampleProductGraph } = await import("../scripts/lib/world/product-graph-sample.mjs");
  const p = product(t, HANDS, handRules());
  const { graph, out } = p.build();
  const before = fs.readdirSync(out).sort();
  const first = sampleProductGraph({ buildDirectory: out, count: 4 });
  const again = sampleProductGraph({ buildDirectory: out, count: 4 });
  assert.equal(first.status, "sampled");
  assert.equal(first.seedFrom, "build");
  assert.deepEqual(first.edges, again.edges);
  assert.equal(first.text, again.text);
  // Every type present is in the sample before any type gets a second edge.
  const types = new Set(graph.edges.map((edge) => edge.type));
  const many = sampleProductGraph({ buildDirectory: out, seed: 7, count: types.size });
  assert.deepEqual(new Set(many.edges.map((edge) => edge.type)), types);
  assert.equal(many.seed, 7);
  assert.match(many.text, /^표본: seed 7, 연결 \d+개 중 \d+개\. 종류: /);
  assert.match(many.text, /\n저장하지 않고 판정하지 않는다\. /);
  const judged = many.edges.find((edge) => edge.type === "경계");
  assert.deepEqual(judged.from, { id: "src/server.js#delegate", type: "코드", file: "src/server.js", lines: [5, 7] });
  assert.equal(judged.evidence.judgement, true);
  assert.match(many.text, /경계: src\/server\.js#delegate \(src\/server\.js:5-7\) → src\/worker\.js#work \(src\/worker\.js:1\) — 읽은 곳 src\/server\.js:6; 근거: 경계, 판단, "another process; not followed"/);
  const only = sampleProductGraph({ buildDirectory: out, seed: 7, count: 30, types: ["call"] });
  assert(only.edges.every((edge) => edge.type === "call"));
  // A given seed gives the same sample again, whatever the build's own seed is.
  assert.deepEqual(sampleProductGraph({ buildDirectory: out, seed: 8, count: 2 }).edges, sampleProductGraph({ buildDirectory: out, seed: 8, count: 2 }).edges);
  assert.deepEqual(fs.readdirSync(out).sort(), before);
  assert.throws(() => sampleProductGraph({ buildDirectory: out, count: 0 }), { code: "PRODUCT_GRAPH_QUERY_INVALID" });
});

test("2.5: tree gives one indented tree per role; a node is expanded once, another 기능's 처리 코드 is named not expanded, a boundary prints", (t) => {
  const p = product(t, { ...TOOLS, ...{ "src/tools.js": lines("export function save() { return write() + write(); }", "export function load() { return read(); }", "function write() { return read(); }", "function read() { return 2; }") } }, { rules: [toolRule({ 입구: ["src/server.js#route"] })] });
  p.build();
  p.ask({ question: "overview" });
  const answer = p.ask({ question: "tree", id: "tool:save" });
  const shape = answer.rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.id || row.text.slice(0, 12)}`);
  assert.deepEqual(shape, [
    "node:tool:save",
    "  group:처리 코드 1개",
    "    node:src/tools.js#save",
    "      node:src/tools.js#write",
    "        node:src/tools.js#read",
    "  group:입구 코드 1개",
    "    node:src/server.js#route",
    "      node:src/server.js#guard",
    "      node:src/tools.js#load",
    "      node:src/tools.js#save",
  ]);
  assert.match(answer.rows.find((row) => row.id === "src/tools.js#load").text, / — tool:load의 처리 코드라 펼치지 않음$/);
  assert.equal(answer.rows.find((row) => row.id === "src/tools.js#load").notExpanded, "otherFunction");
  assert.match(answer.rows.at(-1).text, / — 위에서 펼침$/);
  // Paged: a later page repeats the root and the role heading it continues.
  const second = p.ask({ question: "tree", id: "tool:save", limit: 6, cursor: 6 });
  assert.deepEqual(
    second.rows.filter((row) => row.repeats).map((row) => row.id || row.text),
    ["tool:save", "입구 코드 1개"],
  );
  const pages = [p.ask({ question: "tree", id: "tool:save", limit: 6 }), second];
  assert.equal(pages[0].rows.at(-1).continues, "nextPage");
  const joined = pages.flatMap((one) => one.rows.filter((row) => !row.repeats && row.kind !== "more"));
  assert.deepEqual(
    joined.map((row) => row.text),
    answer.rows.map((row) => row.text),
  );
  // A boundary prints under its node.
  const q = product(t, HANDS, handRules());
  q.build();
  q.ask({ question: "overview" });
  const tree = q.ask({ question: "tree", id: "cli:delegate" });
  assert(tree.rows.some((row) => row.boundary && row.text === "경계에서 멈춤: another process; not followed → src/worker.js#work"));
  const other = q.ask({ question: "tree", id: "src/server.js" });
  assert.match(other.text, /tree는 기능에 묻는다\. 이 노드는 코드이다\./);
});

test("2.5: user gives the steps in order with each 화면요소, the 기능 it calls or that show a result there, and their 처리 코드", (t) => {
  const base = temporary(t);
  const out = path.join(base, "out");
  buildProductGraph({
    sourceRoot: path.join(fixtures, "ui-signal"),
    documentsDirectory: path.join(fixtures, "ui-signal-documents"),
    rulesFile: path.join(fixtures, "empty-rules.json"),
    outputDirectory: out,
  });
  const answer = queryProductGraph({ buildDirectory: out, question: "user", id: "UA-MAIN-01" });
  const steps = answer.rows.filter((row) => row.kind === "group").map((row) => row.text);
  assert.deepEqual(steps.map((text) => text.replace(/ \(.*\)$/, "")), ["차례 1", "차례 2", "차례 3"]);
  const elements = answer.rows.filter((row) => row.depth === 2).map((row) => row.id);
  assert.deepEqual(elements, ["MAIN-01#4", "MAIN-01#1", "MAIN-01#5"]);
  const shows = answer.rows.find((row) => row.relation === "shows");
  assert.equal(shows.id, "fe/station/ui/main_window/MainWindow@effect:_poll");
  assert.deepEqual(shows.evidence, ["문서"]);
  assert.match(shows.text, /^결과를 보여 주는 기능: .* \(근거: 문서\)$/);
  const calls = answer.rows.filter((row) => row.relation === "calls").map((row) => row.id);
  assert.deepEqual(calls, ["fe/station/ui/main_window/MainWindow@clicked:_save", "fe/station/ui/main_window/MainWindow@clicked:_export"]);
  assert(answer.rows.some((row) => row.depth === 4 && row.text.startsWith("처리 코드: 코드 station/ui/main_window.py#MainWindow._save")));
  assert.equal(answer.page.total, answer.rows.length - 1);
});

// ---------- 2.6 run records and machine edges ----------

const SCREEN = (rows) =>
  lines(
    "# MAIN-01 주 화면",
    "",
    "## 이 화면이 무엇인가",
    "",
    "| 항목 | 내용 |",
    "|---|---|",
    "| ID | MAIN-01 |",
    "| 이름 | 주 화면 |",
    "| IA 묶음 | MAIN |",
    "| 추정 | 코드만 보고 쓴 추정 |",
    "",
    "## 화면요소",
    "",
    "| ID | 한 줄 | 위치 | 조작하면 실행되는 기능 | 보여 주는 기능 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  );
const EVIDENCE_SOURCE = {
  "src/app.js": lines(
    'const SUMMARY = "요약 표를 그렸습니다";',
    "export function save(name) {",
    "  return report(`파일을 저장했습니다: ${name}`);",
    "}",
    "export function load() {",
    '  return report("불러오기 실패");',
    "}",
    "export function stats() {",
    "  return report(SUMMARY);",
    "}",
    "function report(text) {",
    "  return text;",
    "}",
  ),
};
const EVIDENCE_ROWS = [
  "| MAIN-01#1 | 저장 알림 `파일을 저장했습니다` | | | |",
  "| MAIN-01#2 | 오류 줄 `불러오기 실패` | | | |",
  "| MAIN-01#3 | 요약 `요약 표를 그렸습니다` | | | |",
  "| MAIN-01#4 | 상태 `어디에도 없는 문구` | | | |",
  "| MAIN-01#5 | 그냥 상자 | | | |",
  "| MAIN-01#6 | 다른 알림 `파일을 저장했습니다` | | | `tool:load` |",
];
const evidenceRules = (extra = {}) => ({
  ...RULES_HEAD,
  rules: [{ 종류: "tool", 판단: true, 파일: ["src/app.js"], 패턴: "export function (save|load|stats)", "처리 코드": "줄을 감싼 코드" }],
  ...extra,
});

// A Lode project holding a synthetic product, its 화면설계서 and rules.
function evidenceProject(t, { source = EVIDENCE_SOURCE, rows = EVIDENCE_ROWS, rules = evidenceRules() } = {}) {
  const f = fixture(t);
  for (const [name, text] of Object.entries(source)) {
    fs.mkdirSync(path.dirname(path.join(f.root, name)), { recursive: true });
    fs.writeFileSync(path.join(f.root, name), text);
  }
  const family = path.join(f.root, ".lode", "context", "product-graph");
  fs.mkdirSync(path.join(family, "화면설계서"), { recursive: true });
  fs.writeFileSync(path.join(family, "화면설계서", "MAIN-01.md"), SCREEN(rows));
  const setRules = (value) => fs.writeFileSync(path.join(family, "호출 방식 표.json"), JSON.stringify(value, null, 2));
  setRules(rules);
  const build = () => buildProductGraph({ root: f.root, includeEstimates: true });
  const graph = () => JSON.parse(fs.readFileSync(path.join(family, "build", "graph.json"), "utf8"));
  const shown = (graphValue) =>
    graphValue.edges
      .filter((edge) => edge.type === "기능→화면요소")
      .map((edge) => `${edge.from} → ${edge.to} [${edge.근거.join("; ")}]${edge.machine ? " machine" : ""}`)
      .sort();
  return { ...f, family, setRules, build, graph, shown };
}

test("2.6: run records add the code hashes; a current run's output, code literals and the document give stated evidence; a stale run gives none", async (t) => {
  const { addProductGraphRuns } = await import("../scripts/lib/world/product-graph.mjs");
  const p = evidenceProject(t);
  const first = p.build();
  // Without run records: code evidence and the document.
  assert.deepEqual(p.shown(p.graph()), [
    "tool:load → MAIN-01#2 [코드 src/app.js:6] machine",
    "tool:load → MAIN-01#6 [문서]",
    "tool:save → MAIN-01#1 [코드 src/app.js:3] machine",
    "tool:stats → MAIN-01#3 [코드 src/app.js:9] machine",
  ]);
  assert.deepEqual(
    first.lists.screenEvidence.unconnected.map((item) => [item.id, item.reason]),
    [
      ["MAIN-01#4", "글이 어느 실행 출력과 코드에도 없음"],
      ["MAIN-01#5", "따옴표로 묶은 글이 없음"],
    ],
  );
  assert.deepEqual(
    first.lists.screenEvidence.documentOnly.map((item) => `${item.from} → ${item.to}`),
    ["tool:load → MAIN-01#6"],
  );
  assert.match(first.text, /\n문서에만 있음\(실행·코드 근거 없음\): 1개\n/);
  assert.match(first.text, /\n실행·코드에만 있음\(문서에 없음\): 3개 /);
  assert.match(first.text, /\n이어지지 않은 화면요소: 2개\n/);
  assert.match(first.text, /- 아무것도 실행하지 않았다\. 문서와 코드를 비교할 뿐이고, 어느 발견도 실행 근거에 기대지 않는다\./);
  // A refusal writes nothing: a 기능 not in the graph, an output over 16 KiB.
  assert.throws(() => addProductGraphRuns({ root: p.root, runs: [{ 기능: "tool:gone", 실행: "x", 출력: "y" }] }), { code: "PRODUCT_GRAPH_RUN_TARGET_MISSING" });
  assert.throws(() => addProductGraphRuns({ root: p.root, runs: [{ 기능: "tool:save", 실행: "x", 출력: "가".repeat(6000) }] }), { code: "PRODUCT_GRAPH_RUN_LIMIT" });
  assert.equal(fs.existsSync(path.join(p.family, "실행 기록")), false);
  const added = addProductGraphRuns({
    root: p.root,
    runs: [{ 기능: "tool:save", 실행: "save a.txt", 상태: "저장함", 출력: "ok\n파일을 저장했습니다: a.txt\n", 종료: 0 }],
    rationale: "smoke run",
  });
  assert.equal(added.status, "recorded");
  assert.equal(added.lodeRan, false);
  const [recordId] = added.records;
  const record = JSON.parse(fs.readFileSync(path.join(p.family, "실행 기록", `${recordId}.json`), "utf8"));
  const save = p.graph().nodes.find((node) => node.id === "tool:save");
  assert.deepEqual(record.runs[0].basis, { id: "tool:save", contentSha256: save.contentSha256, reachSha256: save.reachSha256 });
  assert.equal(record.lodeRan, false);
  const label = `R${recordId.replace("product-graph-run-", "").slice(0, 8)}-1`;
  assert.equal(added.runs[0].id, label);
  // The build after: run evidence; code evidence is not sought for an element a run matched.
  const second = p.build();
  assert(p.shown(p.graph()).includes(`tool:save → MAIN-01#1 [실행 ${label}] machine`));
  assert.match(second.text, new RegExp(`- 아무것도 실행하지 않았다\\. 프로젝트가 넘긴 실행 기록 1개\\(기능 1개\\)를 읽었고, 그중 기능 1개의 실행이 지금 코드에 그대로다\\.`));
  assert.equal(second.lists.runs.current[0].id, label);
  // The code changes: the run is stale, gives no edge, and is listed and marked.
  fs.writeFileSync(path.join(p.root, "src/app.js"), EVIDENCE_SOURCE["src/app.js"].replace("return report(`파일을", "report(name);\n  return report(`파일을"));
  const third = p.build();
  assert.deepEqual(
    third.lists.runs.stale.map((run) => [run.id, run.reason]),
    [[label, "기능이 닿는 코드가 바뀜"]],
  );
  assert(p.shown(p.graph()).every((line) => !line.includes("실행 ")));
  assert.match(third.text, new RegExp(`\\n실행 뒤 코드가 바뀜: 1개 [^\\n]*\\n {2}- ${label} tool:save "save a.txt" \\[저장함\\] 종료 0 — 기능이 닿는 코드가 바뀜\\n`));
  const stale = queryProductGraph({ root: p.root, question: "changes", list: "runsStale" });
  assert.equal(stale.rows[0].id, "tool:save");
  assert.match(queryProductGraph({ root: p.root, question: "node", id: "tool:save" }).rows[0].text, /\{실행: 실행 뒤 코드가 바뀜\}$/);
});

test("2.6: a machine edge never changes a document, an approval or a 확인 record; 빼는 연결 removes one and a stale rule is listed", async (t) => {
  const { approveProductGraphDocument, confirmProductGraph } = await import("../scripts/lib/world/product-graph.mjs");
  const p = evidenceProject(t);
  const document = path.join(p.family, "화면설계서", "MAIN-01.md");
  const before = fs.readFileSync(document);
  const built = p.build();
  const digest = built.documents.list.find((item) => item.path === "화면설계서/MAIN-01.md").approvalDigest;
  approveProductGraphDocument({ root: p.root, document: "화면설계서/MAIN-01.md", expectedSha256: digest, rationale: "read it" });
  const approved = p.build();
  assert.equal(approved.documents.list.find((item) => item.path === "화면설계서/MAIN-01.md").status, "승인");
  assert.deepEqual(fs.readFileSync(document), before);
  // The confirmation records cover document rows only: no machine edge in them.
  const confirmed = confirmProductGraph({ root: p.root, documents: ["화면설계서/MAIN-01.md"] });
  for (const id of confirmed.records) {
    const record = JSON.parse(fs.readFileSync(path.join(p.family, "확인", `${id}.json`), "utf8"));
    assert(record.items.every((item) => item.kind === "documentRow" && item.from === "tool:load" && item.to === "MAIN-01#6"), JSON.stringify(record.items));
  }
  // A judged rule removes a wrong machine edge; one that matches none is stale.
  p.setRules(
    evidenceRules({
      "빼는 연결": [
        { 판단: true, 기능: "tool:stats", 화면요소: "MAIN-01#3", 이유: "the summary is drawn elsewhere" },
        { 판단: true, 기능: "tool:load", 화면요소: "MAIN-01#1", 이유: "never matched" },
      ],
    }),
  );
  const ruled = p.build();
  assert(!p.shown(p.graph()).some((line) => line.startsWith("tool:stats → MAIN-01#3")));
  assert.deepEqual(ruled.lists.screenEvidence.removed, [{ from: "tool:stats", to: "MAIN-01#3", rule: 0, 이유: "the summary is drawn elsewhere" }]);
  assert.deepEqual(
    ruled.lists.ruleIssues.map((item) => item.reason),
    ["규칙이 낡음 — 빼려는 기계 연결이 없음"],
  );
  assert.deepEqual(fs.readFileSync(document), before);
  // A machine edge is in no 다시 볼 것 list: those are document rows.
  assert(!(ruled.changes.reviewAgain?.documentRows || []).some((row) => row.to !== "MAIN-01#6" && row.type === "기능→화면요소"));
});

test("2.6: export, import, folder-copy adoption and GC keep and verify run records like 확인 records; limits refuse", async (t) => {
  const { addProductGraphRuns } = await import("../scripts/lib/world/product-graph.mjs");
  const { exportProjectBundle, importProjectBundle, inspectProjectBundle } = await import("../scripts/lib/storage/project-portability.mjs");
  const { adoptVerifiedProjectCopy } = await import("../scripts/lib/storage/project-copy-adoption.mjs");
  const { buildSnapshotDeletionClosure } = await import("../scripts/lib/world/snapshot-deletion-closure.mjs");
  const { PRODUCT_GRAPH_RUN_MAX_RECORDS } = await import("../scripts/lib/storage/product-graph-store.mjs");
  const p = evidenceProject(t);
  p.build();
  const added = addProductGraphRuns({ root: p.root, runs: [{ 기능: "tool:load", 실행: "load", 출력: "불러오기 실패" }] });
  const name = `.lode/context/product-graph/실행 기록/${added.records[0]}.json`;
  const bundle = p.route(() => exportProjectBundle({ root: p.root, destination: path.join(p.base, "bundle") }));
  assert(inspectProjectBundle({ bundleRoot: bundle.bundleRoot }).manifest.files.some((file) => file.path === name));
  const target = path.join(p.base, "imported");
  fs.mkdirSync(target);
  assert.equal(importProjectBundle({ bundleRoot: bundle.bundleRoot, root: target, pluginRoot }).status, "imported");
  assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(p.root, name)));
  const closure = await buildSnapshotDeletionClosure({ root: p.root });
  assert.deepEqual(
    closure.issues.filter((item) => item.path.includes("product-graph")),
    [],
  );
  assert(closure.entries.some((row) => row.path === name));
  const unverified = (root) => {
    const file = path.join(root, ".lode/project.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n");
    const manifestFile = path.join(root, ".lode/generated/manifest.json"),
      manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.managed.find((entry) => entry.path === ".lode/project.json").sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  };
  const copy = path.join(p.base, "copy");
  fs.cpSync(p.root, copy, { recursive: true });
  unverified(copy);
  assert.equal(adoptVerifiedProjectCopy({ root: copy, pluginRoot }).status, "verified-copy-adopted");
  const broken = path.join(p.base, "broken");
  fs.cpSync(p.root, broken, { recursive: true });
  unverified(broken);
  fs.writeFileSync(path.join(broken, name), fs.readFileSync(path.join(broken, name), "utf8").replace("불러오기 실패", "불러오기 성공"));
  assert.throws(() => adoptVerifiedProjectCopy({ root: broken, pluginRoot }), { code: "PRODUCT_GRAPH_RUN_INVALID" });
  // A record a build cannot verify is an issue and gives no evidence.
  fs.writeFileSync(path.join(p.root, name), fs.readFileSync(path.join(p.root, name), "utf8").replace("불러오기 실패", "불러오기 성공"));
  const rebuilt = p.build();
  assert.deepEqual(
    rebuilt.lists.runs.issues.map((item) => item.reason),
    ["실행 기록의 모양이나 내용 주소가 맞지 않는다"],
  );
  assert.equal(rebuilt.lists.runs.records, 0);
  // The record limit is enforced by refusal.
  fs.rmSync(path.join(p.root, name));
  const folder = path.join(p.family, "실행 기록");
  for (let index = 0; index < PRODUCT_GRAPH_RUN_MAX_RECORDS; index += 1)
    fs.writeFileSync(path.join(folder, `product-graph-run-${index.toString(16).padStart(24, "0")}.json`), "{}");
  p.build();
  assert.throws(() => addProductGraphRuns({ root: p.root, runs: [{ 기능: "tool:load", 실행: "load", 출력: "x" }] }), { code: "PRODUCT_GRAPH_RUN_LIMIT" });
});

test("2.6 acceptance 4: a seeded sample of machine edges on a product with shared phrases shows the wrong ones, and 빼는 연결 removes them", async (t) => {
  const { sampleProductGraph } = await import("../scripts/lib/world/product-graph-sample.mjs");
  const shared = {
    "src/app.js": lines(
      "export function save() { return report(\"저장했습니다\"); }",
      "export function exportFile() { return report(\"저장했습니다\"); }",
      "export function load() { return report(\"불러왔습니다\"); }",
      "function report(text) { return text; }",
    ),
  };
  const rules = evidenceRules();
  rules.rules[0].패턴 = "export function (save|exportFile|load)";
  const p = evidenceProject(t, { source: shared, rows: ["| MAIN-01#1 | 저장 알림 `저장했습니다` | | | |", "| MAIN-01#2 | 불러온 알림 `불러왔습니다` | | | |"], rules });
  p.build();
  const sample = sampleProductGraph({ root: p.root, seed: 42, types: ["기능→화면요소"] });
  assert.equal(sample.seed, 42);
  const picked = sample.edges.map((edge) => `${edge.from.id} → ${edge.to.id} [${edge.evidence.근거.join("; ")}]`).sort();
  // The shared phrase gives the export 기능 an edge too: the wrong one.
  assert.deepEqual(picked, [
    "tool:exportFile → MAIN-01#1 [코드 src/app.js:2]",
    "tool:load → MAIN-01#2 [코드 src/app.js:3]",
    "tool:save → MAIN-01#1 [코드 src/app.js:1]",
  ]);
  p.setRules({ ...rules, "빼는 연결": [{ 판단: true, 기능: "tool:exportFile", 화면요소: "MAIN-01#1", 이유: "export shows its own notice" }] });
  p.build();
  assert.deepEqual(
    sampleProductGraph({ root: p.root, seed: 42, types: ["기능→화면요소"] }).edges.map((edge) => `${edge.from.id} → ${edge.to.id}`).sort(),
    ["tool:load → MAIN-01#2", "tool:save → MAIN-01#1"],
  );
});

// ---------- 2.7 checking reach against a coverage run ----------

test("2.7: V8 coverage maps run functions to declarations; it lists what ran outside the reach and what the reach says did not run", async (t) => {
  const { coverageProductGraph } = await import("../scripts/lib/world/product-graph-coverage.mjs");
  const { pathToFileURL } = await import("node:url");
  const p = product(t, TOOLS, { rules: [toolRule({ 입구: ["src/server.js#route"] })] });
  p.build();
  const v8 = path.join(p.base, "v8");
  fs.mkdirSync(v8);
  const text = (name) => fs.readFileSync(path.join(p.source, name), "utf8");
  const fn = (name, needle, count = 1) => {
    const body = text(name);
    const start = body.indexOf(needle);
    return { functionName: needle, isBlockCoverage: false, ranges: [{ startOffset: start, endOffset: start + needle.length, count }] };
  };
  const script = (name, functions) => ({
    scriptId: name,
    url: pathToFileURL(path.join(p.source, name)).href,
    functions: [{ functionName: "", isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: text(name).length, count: 1 }] }, ...functions],
  });
  const write = (scripts) => fs.writeFileSync(path.join(v8, "coverage-1.json"), JSON.stringify({ result: scripts }));
  write([
    script("src/tools.js", [fn("src/tools.js", "function save()"), fn("src/tools.js", "function read()"), fn("src/tools.js", "function write()", 0)]),
    script("src/server.js", [fn("src/server.js", "export function route("), fn("src/server.js", "function guard(", 0)]),
  ]);
  const answer = coverageProductGraph({ buildDirectory: p.base + "/out-1", sourceRoot: p.source, feature: "tool:save", v8 });
  assert.equal(answer.status, "compared");
  assert.deepEqual(answer.comparedFiles, ["src/server.js", "src/tools.js"]);
  // read ran but tool:save does not reach it (it is tool:load's); route is 입구, inside the range.
  assert.deepEqual(answer.ranOutsideReach, ["src/tools.js#read"]);
  assert(answer.ranOutsideReach.includes("src/tools.js#read"));
  assert(!answer.ranOutsideReach.includes("src/server.js#route"));
  assert.deepEqual(answer.reachedNotRun, ["src/server.js#guard", "src/tools.js#write"]);
  assert.match(answer.text, /\n읽은 형식: V8 coverage/);
  assert.match(answer.text, /\n닿는다고 했는데 돌지 않음: 2개 \(가지 않은 분기와 오류 경로도 여기에 든다/);
  assert.equal(fs.readdirSync(v8).length, 1);
  // A file changed since the run is skipped and named.
  fs.writeFileSync(path.join(p.source, "src/server.js"), `${text("src/server.js")}// changed\n`);
  const changed = coverageProductGraph({ buildDirectory: p.base + "/out-1", sourceRoot: p.source, feature: "tool:save", v8 });
  assert.deepEqual(changed.differs, [{ path: "src/server.js", reason: "실행한 길이와 지금 길이가 다름" }]);
  assert.match(changed.text, /\n실행한 파일이 지금 소스와 다름: 1개 \(건너뜀\)\n {2}- src\/server\.js — 실행한 길이와 지금 길이가 다름\n/);
  assert.deepEqual(changed.comparedFiles, ["src/tools.js"]);
  // Nothing compared: both lists say so, never 0.
  write([{ ...script("src/server.js", []), functions: [{ functionName: "", isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }]);
  const none = coverageProductGraph({ buildDirectory: p.base + "/out-1", sourceRoot: p.source, feature: "tool:save", v8 });
  assert.equal(none.status, "not-compared");
  assert.equal(none.ranOutsideReach, null);
  assert.equal(none.reachedNotRun, null);
  assert.match(none.text, /\n실행됐는데 닿는 범위 밖: 비교하지 않음 — [^\n]+\n닿는다고 했는데 돌지 않음: 비교하지 않음 — /);
  assert.doesNotMatch(none.text, /: 0개/);
  assert.deepEqual(
    none.missing.map((item) => item.list),
    ["ranOutsideReach", "reachedNotRun"],
  );
});
