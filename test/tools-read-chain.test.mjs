// lode_tools_read_chain: a declarative chain of read-only calls run inside the
// server, and the product graph answer changes that go with it (R1-R3).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import {
  buildProductGraph,
  checkProductGraph,
  confirmProductGraph,
  moveProductGraphBaseline,
  readProductGraphBuild,
  renderProductGraphText,
} from "../scripts/lib/world/product-graph.mjs";
import { productGraphQueryContext, queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import { productGraphWalk as walk } from "../scripts/graph-explorer/product-graph-walk.js";
import { chainReadTarget, dispatch, operationCatalogTools, tools, toolsForSurface } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { READ_CHAIN_LIMITS, READ_CHAIN_REFERENCE, runReadChain } from "../scripts/lib/core/tools-read-chain.mjs";
import { RESULT_SHAPE_TOOLS, chainCompletenessFor, resultShapeFor } from "../scripts/lib/core/tool-result-shapes.mjs";
import { SESSION_HOST_REQUEST_HELPER, claudeNativeHookMatchers } from "../scripts/lib/session/session-host-request.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session/session-native-host.mjs";
import { registryCatalog } from "../scripts/lib/session/operation-registry.mjs";
import { formatMcpToolContent } from "../scripts/lib/session/cli-presentation.mjs";

const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
const SAVE = "fe/station/ui/main_window/MainWindow@clicked:_save";
const SAVE_CODE = "station/ui/main_window.py#MainWindow._save";
const QUERY = "lode_product_graph_query";
const CHAINABLE = ["lode_product_graph_query", "lode_project_graph"];

// The ui-signal fixture with its documents, built, with a baseline, then _save
// edited and built again: three code nodes changed, two features reach changed
// code.
function graphProject(t, { confirm = false } = {}) {
  const f = fixture(t);
  fs.cpSync(path.join(fixtures, "ui-signal"), f.root, { recursive: true });
  const family = path.join(f.root, ".lode", "context", "product-graph");
  fs.cpSync(path.join(fixtures, "ui-signal-documents"), family, { recursive: true });
  buildProductGraph({ root: f.root });
  moveProductGraphBaseline({ root: f.root });
  if (confirm) {
    buildProductGraph({ root: f.root });
    confirmProductGraph({ root: f.root, features: [SAVE], rationale: "Re-read _save." });
  }
  const window = path.join(f.root, "station", "ui", "main_window.py");
  fs.writeFileSync(
    window,
    fs
      .readFileSync(window, "utf8")
      .replace("    def _save(self):\n        self.model.refresh()", "    def _save(self):\n        self.model.refresh()\n        self.model.refresh()"),
  );
  buildProductGraph({ root: f.root });
  return { ...f, family, window };
}

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function tree(root) {
  const out = {};
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else {
        const bytes = fs.readFileSync(path.join(root, child));
        out[child] = `${bytes.length}:${sha(bytes)}`;
      }
    }
  };
  visit("");
  return out;
}

let ids = 0;
const read = async (name, args, options) =>
  await dispatch({ jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { name: "lode_tools_read", arguments: { name, arguments: args } } }, options);
const chain = async (args, options) =>
  await dispatch({ jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { name: "lode_tools_read_chain", arguments: args } }, options);
const answer = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
};
const single = (root, name, args = {}, extra = {}) => ({
  project_root: root,
  steps: [{ id: "s", read: { name, arguments: args }, ...extra }],
  return: [{ from: "s" }],
});

// ---------- a fake tool for the engine ----------

const FAKE = Object.freeze({
  rows: "rows",
  answered: { field: "status", in: ["ok"] },
  refused: { field: "status", in: ["refused"] },
  code: ["code"],
  message: ["message"],
  pages: { next: "page.next", remaining: "page.remaining" },
  cut: [{ field: "truncated", eq: true, count: "omitted" }],
  basisChanged: { field: "status", in: ["basis-changed"] },
  identity: "build",
});
// "nope" is refused at validation; an item value "refuse-me" is refused for that item only.
const fakeTarget = (name, args = {}) =>
  name === "nope" || args.item === "refuse-me"
    ? { ok: false, code: "CHAIN_TOOL_NOT_CHAINABLE", message: "no" }
    : { ok: true, name, operation: name, declaresProjectRoot: true, completeness: FAKE };
function fakeCall({ rows = 3, size = 10, pageSize = null, answer: shape = () => ({}), fail = () => null, onCall = () => {} } = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push(args);
    onCall(calls.length, args);
    const failure = fail(args, calls.length);
    if (failure === "none") return null;
    if (failure === "isError") return { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "bad" }] } };
    if (failure === "noStructure") return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain" }] } };
    if (failure === "refused") return { jsonrpc: "2.0", id: 1, result: { structuredContent: { status: "refused", code: "FAKE_REFUSED", message: "said no" } } };
    if (failure) return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: failure, data: { reasonCode: "FAKE_FAILED" } } };
    const count = typeof rows === "function" ? rows(args) : rows;
    const width = typeof size === "function" ? size(args) : size;
    const cursor = args.cursor ?? 0;
    const all = Array.from({ length: count }, (_, index) => ({ n: index, pad: "x".repeat(width) }));
    const slice = pageSize ? all.slice(cursor, cursor + pageSize) : all;
    const remaining = pageSize ? Math.max(0, count - cursor - pageSize) : 0;
    const value = {
      status: "ok",
      rows: slice,
      ...(remaining ? { page: { remaining, next: { ...args, cursor: cursor + pageSize } } } : {}),
      ...shape(args, calls.length),
    };
    return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "" }], structuredContent: value } };
  };
  return { call, calls };
}
const run = (input, fake, extra = {}) => runReadChain({ project_root: "P", ...input }, { resolveTarget: fakeTarget, call: fake.call, ...extra });
const src = (extra = {}) => ({ id: "src", read: { name: "t", arguments: {} }, ...extra });
const per = (extra = {}, each = {}) => ({
  id: "per",
  each: { from: "src", value: "n", ...each },
  read: { name: "t", arguments: { item: { $item: true } } },
  ...extra,
});

// ---------- T1: the router ----------

test("T1: the chain is on the default surface, read-only, a router in the hook matchers, and not an inner call of lode_tools_read", async (t) => {
  const listed = tools.find((tool) => tool.name === "lode_tools_read_chain");
  assert.ok(listed, "listed by default");
  assert.equal(listed.annotations.readOnlyHint, true);
  assert.equal(listed.annotations.destructiveHint, false);
  assert.ok(toolsForSurface("managed-maintenance").some((tool) => tool.name === "lode_tools_read_chain"));
  for (const matcher of claudeNativeHookMatchers(registryCatalog())) assert.match(matcher, /\|lode_tools_read_chain\|/);
  const hooks = fs.readFileSync(path.join(pluginRoot, "hooks", "claude.json"), "utf8");
  assert.equal((hooks.match(/\|lode_tools_read_chain\|/g) || []).length, 2, "both PreToolUse matchers name it");
  const f = fixture(t);
  const nested = await read("lode_tools_read_chain", { project_root: f.root, steps: [], return: [] });
  assert.match(nested.error.message, /routing cannot be nested/);
  const discovered = answer(
    await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_discover", arguments: { name: "lode_tools_read_chain" } } }),
  );
  assert.equal(discovered.tools[0].name, "lode_tools_read_chain");
  assert.deepEqual(discovered.tools[0].reference.bounds, READ_CHAIN_REFERENCE.bounds);
  const bogus = await chain(single(f.root, QUERY), { surface: "no-such-surface" });
  assert.ok(bogus.error, "an unknown surface is refused before the chain runs");
});

// ---------- T5.1: validation before any call ----------

test("T5.1: every invalid program is refused before any inner call, with every problem at once", async (t) => {
  const f = fixture(t);
  const calls = [];
  const spy = async (name) => {
    calls.push(name);
    return null;
  };
  const step = (id, name, args = {}, extra = {}) => ({ id, read: { name, arguments: args }, ...extra });
  const deep = (depth) => {
    let value = 1;
    for (let index = 0; index < depth; index += 1) value = { a: value };
    return value;
  };
  const eachOf = (args, name = QUERY) => ({ id: "b", each: { from: "a", value: "id" }, read: { name, arguments: args } });
  const cases = [
    ["not read-only", { steps: [step("a", "lode_session_work_record")] }, /not read-only/],
    ["unknown tool", { steps: [step("a", "lode_no_such_tool")] }, /Unknown tool/],
    ["router", { steps: [step("a", "lode_tools_read")] }, /cannot be an inner call/],
    ["the chain itself", { steps: [step("a", "lode_tools_read_chain")] }, /cannot be an inner call/],
    ["legacy chain name", { steps: [step("a", "head_tools_read_chain")] }, /cannot be an inner call/],
    ["discovery", { steps: [step("a", "lode_tools_discover")] }, /cannot be an inner call/],
    ["a tool without a completeness declaration", { steps: [step("a", "lode_session_list")] }, /a chain calls only tools/],
    ["a Session-bound read", { steps: [step("a", "lode_project_status")] }, /a chain calls only tools/],
    ["inventory mode", { steps: [step("a", "lode_project_graph", { inventory_page: true })] }, /inventory_page cannot be an inner call/],
    ["pages on a tool without pages", { steps: [step("a", "lode_project_graph", {}, { pages: 2 })] }, /no next-page arguments/],
    ["second project root", { steps: [step("a", QUERY, { project_root: path.join(f.root, "other") })] }, /another project_root/],
    ["$item as project_root", { steps: [step("a", QUERY), eachOf({ project_root: { $item: true } })] }, /supplied by the chain/],
    ["$item as action", { steps: [step("a", QUERY), eachOf({ action: { $item: true } }, "lode_product_graph")] }, /action/],
    ["nested $item", { steps: [step("a", QUERY), eachOf({ node_types: [{ $item: true }] })] }, /whole argument value/],
    ["$item without each", { steps: [step("a", QUERY, { id: { $item: true } })] }, /only in a step with each/],
    ["unknown step kind", { steps: [{ id: "a", frob: {} }] }, /exactly one of/],
    ["unknown step key", { steps: [step("a", QUERY, {}, { extra: 1 })] }, /does not belong/],
    ["duplicate step id", { steps: [step("a", QUERY), step("a", QUERY)] }, /used twice/],
    ["forward reference", { steps: [{ id: "a", from: "b", limit: 1 }, step("b", QUERY)] }, /not an earlier step/],
    ["unknown top-level field", { steps: [step("a", QUERY)], extra: true }, /Unknown chain field/],
    ["13 steps", { steps: Array.from({ length: 13 }, (_, index) => step(`s${index}`, QUERY)) }, /at most 12 steps/],
    ["each max 21", { steps: [step("a", QUERY), { ...eachOf({}), each: { from: "a", value: "id", max: 21 } }] }, /max is 1 to 20/],
    ["pages 11", { steps: [step("a", QUERY, {}, { pages: 11 })] }, /pages is 1 to 10/],
    ["max_bytes over 64 KiB", { steps: [step("a", QUERY)], max_bytes: 64 * 1024 + 1 }, /max_bytes is an integer/],
    ["max_bytes under the minimum", { steps: [step("a", QUERY)], max_bytes: READ_CHAIN_LIMITS.minBytes - 1 }, /max_bytes is an integer/],
    ["input over 64 KiB", { steps: [step("a", QUERY, { text: "x".repeat(70 * 1024) })] }, /bytes; at most/],
    [
      "condition nested three levels",
      { steps: [step("a", QUERY), { id: "b", from: "a", where: { all: [{ any: [{ all: [{ field: "kind", eq: "x" }] }] }] } }] },
      /nest at most 2/,
    ],
    ["a literal nested 5000 deep", { steps: [step("a", QUERY, { text: deep(5000) })] }, /nests deeper than 32/],
    [
      "in with 101 values",
      { steps: [step("a", QUERY), { id: "b", from: "a", where: { field: "kind", in: Array.from({ length: 101 }, (_, i) => i) } }] },
      /at most 100 values/,
    ],
    ["pick 33 fields", { steps: [step("a", QUERY), { id: "b", from: "a", pick: Array.from({ length: 33 }, (_, i) => `f${i}`) }] }, /1 to 32 fields/],
    ["a path of five parts", { steps: [step("a", QUERY), { id: "b", from: "a", sort: { by: "a.b.c.d.e" } }] }, /sort is/],
  ];
  for (const [label, input, pattern] of cases) {
    const value = await runReadChain(
      { project_root: f.root, return: [{ from: input.steps[0].id ?? "a" }], ...input },
      { resolveTarget: chainReadTarget, call: spy },
    );
    assert.equal(value.status, "refused", label);
    assert.ok(
      value.issues.some((issue) => pattern.test(issue.message)),
      `${label}: ${JSON.stringify(value.issues).slice(0, 600)}`,
    );
    assert.equal(value.ran.calls, 0, label);
    assert.equal(value.everythingSeen, false, label);
  }
  assert.deepEqual(calls, [], "no inner call ran");
  const refused = answer(
    await chain({
      project_root: f.root,
      steps: [step("a", "lode_session_work_record"), step("b", "lode_tools_call"), { id: "c", from: "zz", limit: 1 }],
      return: [{ from: "a" }, { from: "nope" }],
    }),
  );
  assert.equal(refused.status, "refused");
  assert.deepEqual(
    refused.issues.map((issue) => issue.at),
    ["steps[0].read.name", "steps[1].read.name", "steps[2].from", "return[1].from"],
  );
  assert.equal(refused.grantsAuthorization, false);
});

// ---------- the row steps ----------

test("T3: every operator, limit, sort (stable, missing last), unique, count (missing apart from null) and pick (nesting kept)", async () => {
  const rows = [
    { id: 1, kind: "node", name: "alpha", tags: ["x", "y"], n: 3, deep: { v: "a" } },
    { id: 2, kind: "text", name: "beta", tags: ["y"], n: 1, deep: { v: "b" } },
    { id: 3, kind: "node", name: "alphabet", n: null, deep: { v: "a" } },
    { id: 4, kind: "node", name: "gamma", tags: [], n: 2 },
    { id: 5, kind: "more", n: 1 },
  ];
  const fake = fakeCall({ rows: 0, answer: () => ({ rows }) });
  const cases = [
    [{ field: "kind", eq: "node" }, [1, 3, 4]],
    [{ field: "kind", ne: "node" }, [2, 5]],
    [{ field: "kind", in: ["text", "more"] }, [2, 5]],
    [{ field: "name", contains: "pha" }, [1, 3]],
    [{ field: "tags", contains: "y" }, [1, 2]],
    [{ field: "name", startsWith: "al" }, [1, 3]],
    [{ field: "tags", exists: false }, [3, 5]],
    [{ field: "n", exists: true }, [1, 2, 4, 5]],
    [{ field: "n", gte: 2 }, [1, 4]],
    [{ field: "n", lte: 1 }, [2, 5]],
    [{ field: "name", gte: "b" }, [2, 4]],
    [{ field: "deep.v", eq: "a" }, [1, 3]],
    [
      {
        any: [
          { field: "id", eq: 2 },
          {
            all: [
              { field: "kind", eq: "node" },
              { field: "n", gte: 3 },
            ],
          },
        ],
      },
      [1, 2],
    ],
  ];
  for (const [condition, expected] of cases) {
    const value = await run({ steps: [src(), { id: "w", from: "src", where: condition }], return: [{ from: "w" }] }, fake);
    assert.deepEqual(
      value.results.w.rows.map((row) => row.id),
      expected,
      JSON.stringify(condition),
    );
  }
  const steps = (step) => run({ steps: [src(), { id: "x", from: "src", ...step }], return: [{ from: "x" }] }, fake);
  const idsOf = async (step) => (await steps(step)).results.x.rows.map((row) => row.id);
  assert.deepEqual(await idsOf({ limit: 2 }), [1, 2]);
  assert.equal((await steps({ limit: 0 })).results.x.total, 0);
  assert.deepEqual(await idsOf({ sort: { by: "n" } }), [2, 5, 4, 1, 3], "stable, null last");
  assert.deepEqual(await idsOf({ sort: { by: "n", order: "desc" } }), [1, 4, 2, 5, 3], "stable, null last");
  assert.deepEqual((await idsOf({ sort: { by: "tags" } })).slice(-2), [3, 5], "missing last");
  assert.deepEqual(await idsOf({ unique: { by: "kind" } }), [1, 2, 5]);
  assert.deepEqual((await steps({ count: { by: "n" } })).results.x.rows, [
    { value: 3, count: 1 },
    { value: 1, count: 2 },
    { value: null, count: 1 },
    { value: 2, count: 1 },
  ]);
  assert.deepEqual((await steps({ count: { by: "deep.v" } })).results.x.rows, [
    { value: "a", count: 2 },
    { value: "b", count: 1 },
    { value: null, missing: true, count: 2 },
  ]);
  // A picked path keeps its nesting, so a later step addresses it by the same path.
  const picked = await run(
    { steps: [src(), { id: "p", from: "src", pick: ["deep.v", "id"] }, { id: "w", from: "p", where: { field: "deep.v", eq: "a" } }], return: [{ from: "w" }] },
    fake,
  );
  assert.deepEqual(picked.results.w.rows, [
    { deep: { v: "a" }, id: 1 },
    { deep: { v: "a" }, id: 3 },
  ]);
});

// ---------- equivalence, determinism, nothing written ----------

test("T3, T5.5, T5.6: a chain's rows equal the same calls made one by one with the same filtering; output is byte-identical; the Project is unchanged", async (t) => {
  const f = graphProject(t);
  const input = {
    project_root: f.root,
    steps: [
      { id: "todo", read: { name: QUERY, arguments: { question: "changes", list: "reviewAgain", limit: 2 } }, pages: 3 },
      { id: "nodes", from: "todo", where: { field: "kind", eq: "node" } },
      { id: "one", from: "nodes", unique: { by: "id" } },
      {
        id: "callers",
        each: { from: "one", value: "id" },
        read: { name: "lode_product_graph", arguments: { action: "query", question: "up", id: { $item: true } } },
      },
      {
        id: "callerNodes",
        from: "callers",
        where: {
          all: [
            { field: "kind", eq: "node" },
            { field: "depth", gte: 1 },
          ],
        },
      },
      { id: "busy", from: "callerNodes", count: { by: "item" } },
      { id: "top", from: "busy", sort: { by: "count", order: "desc" } },
    ],
    return: [{ from: "top", limit: 10 }, { from: "callerNodes" }],
  };
  const before = tree(f.root);
  const first = (await chain(input)).result;
  const second = (await chain(input)).result;
  assert.equal(JSON.stringify(second), JSON.stringify(first), "byte-identical for the same input and state");
  assert.deepEqual(tree(f.root), before, "the Project folder is unchanged");
  const value = first.structuredContent;
  assert.equal(value.status, "completed");
  assert.equal(value.everythingSeen, true, JSON.stringify(value.notSeenBecause));
  assert.equal(first.content[0].text, JSON.stringify(value), "the content text is no larger than the JSON");
  const todo = [];
  let args = { project_root: f.root, question: "changes", list: "reviewAgain", limit: 2 };
  let calls = 0;
  for (let page = 0; page < 3 && args; page += 1) {
    const got = answer(await read(QUERY, args));
    calls += 1;
    todo.push(...got.rows);
    args = got.page?.nextMcpArguments ?? null;
  }
  const one = [];
  for (const row of todo.filter((entry) => entry.kind === "node")) if (!one.some((seen) => seen.id === row.id)) one.push(row);
  const callers = [];
  for (const row of one) {
    const got = answer(await read(QUERY, { project_root: f.root, question: "up", id: row.id }));
    calls += 1;
    callers.push(...got.rows.map((entry) => ({ ...entry, item: row.id })));
  }
  const callerNodes = callers.filter((row) => row.kind === "node" && row.depth >= 1);
  const counts = new Map();
  for (const row of callerNodes) counts.set(row.item, (counts.get(row.item) || 0) + 1);
  const top = [...counts].map(([item, count]) => ({ value: item, count })).sort((a, b) => b.count - a.count);
  assert.deepEqual(value.results.callerNodes.rows, callerNodes);
  assert.deepEqual(value.results.top.rows, top.slice(0, 10));
  assert.equal(value.ran.calls, calls);
  assert.deepEqual(
    value.basis.map((entry) => [entry.tool, entry.pinned]),
    [[QUERY, true]],
  );
  assert.equal(value.header.length, 3, "the repeated header is given once");
});

test("E6: pages of the listed grouped name follow to the end; stopping early counts what is left", async (t) => {
  const f = graphProject(t);
  const direct = [];
  let args = { project_root: f.root, question: "changes", list: "neverChecked", limit: 3 };
  while (args) {
    const got = answer(await read(QUERY, args));
    direct.push(...got.rows.filter((row) => row.kind !== "more"));
    args = got.page?.nextMcpArguments ?? null;
  }
  assert.ok(direct.length > 6, "more than two pages");
  const value = answer(
    await chain({
      project_root: f.root,
      steps: [
        { id: "p", read: { name: "lode_product_graph", arguments: { action: "query", question: "changes", list: "neverChecked", limit: 3 } }, pages: 10 },
        { id: "items", from: "p", where: { field: "kind", ne: "more" } },
      ],
      return: [{ from: "items" }],
    }),
  );
  assert.equal(value.ran.failed, 0, JSON.stringify(value.issues));
  assert.deepEqual(value.results.items.rows, direct);
  assert.equal(value.everythingSeen, true);
  const two = answer(await chain(single(f.root, "lode_product_graph", { action: "query", question: "changes", list: "neverChecked", limit: 3 }, { pages: 2 })));
  assert.equal(two.notSeen.pagesLeft, 1);
  assert.equal(two.notSeen.itemsLeft, direct.length - 6);
  assert.equal(two.everythingSeen, false);
  assert.ok(two.notSeenBecause.includes("NOT_SEEN_pagesLeft"));
});

// ---------- T4: bounds, past them ----------

test("T4: each counts its calls with pages and stops past its max; the total stops past 40; both are counted", async () => {
  const each = await run({ steps: [src(), per()], return: [{ from: "per", limit: 0 }] }, fakeCall({ rows: 25 }));
  assert.equal(each.ran.calls, 21, "one read and twenty, not twenty-five");
  assert.equal(each.notSeen.eachSkipped, 5);
  assert.equal(each.everythingSeen, false);
  // max counts inner calls, pages included: 3 calls cover one item's two pages and the next item's first.
  const paged = await run(
    { steps: [src({ pages: 2 }), per({ pages: 2 }, { max: 3 })], return: [{ from: "per", limit: 0 }] },
    fakeCall({ rows: 4, pageSize: 2 }),
  );
  assert.equal(paged.ran.calls, 2 + 3);
  assert.equal(paged.notSeen.pagesLeft, 1, "the second item's second page");
  assert.equal(paged.notSeen.eachSkipped, 2);
  const total = await run(
    {
      steps: [
        src(),
        { id: "a", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
        { id: "b", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
      ],
      return: [{ from: "b", limit: 0 }],
    },
    fakeCall({ rows: 25 }),
  );
  assert.equal(total.ran.calls, 40);
  assert.equal(total.notSeen.callsSkipped, 1, "the 41st call is counted, not made");
  assert.equal(total.notSeen.eachSkipped, 5 + 5);
});

test("T4: pages stop at the asked number; intermediate rows stop past 16 MiB; rows without the each value are counted; long lists do not overflow", async () => {
  const paged = await run({ steps: [src({ pages: 2 })], return: [{ from: "src" }] }, fakeCall({ rows: 10, pageSize: 3 }));
  assert.equal(paged.ran.calls, 2);
  assert.deepEqual([paged.results.src.total, paged.notSeen.pagesLeft, paged.notSeen.itemsLeft], [6, 1, 4]);
  const memory = await run(
    { steps: [src(), per()], return: [{ from: "per", limit: 0 }] },
    fakeCall({ rows: (args) => (args.item === undefined ? 20 : 1), size: (args) => (args.item === undefined ? 1 : 1024 * 1024) }),
  );
  assert.equal(memory.results.per.total, 15);
  assert.deepEqual([memory.notSeen.rowsDropped, memory.notSeen.callsSkipped], [1, 4]);
  assert.equal(memory.ran.calls, 1 + 16);
  const holes = await run(
    {
      steps: [src(), { id: "per", each: { from: "src", value: "gap" }, read: { name: "t", arguments: { item: { $item: true } } } }],
      return: [{ from: "per" }],
    },
    fakeCall({ rows: 0, answer: (args) => (args.item === undefined ? { rows: [{ gap: 1 }, { other: 2 }, { gap: null }] } : {}) }),
  );
  assert.equal(holes.notSeen.eachNoValue, 2);
  assert.equal(holes.ran.calls, 2);
  assert.equal(holes.everythingSeen, false);
  assert.ok(holes.notSeenBecause.includes("NOT_SEEN_eachNoValue"));
  const many = await run({ steps: [src()], return: [{ from: "src", limit: 1 }] }, fakeCall({ rows: 200_000, size: 1 }));
  assert.equal(many.results.src.total, 200_000);
});

test("E4: the answer as sent is never over max_bytes, over many generated inputs", async () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 60; round += 1) {
    const maxBytes = READ_CHAIN_LIMITS.minBytes + Math.floor(random() * (READ_CHAIN_LIMITS.maxBytes - READ_CHAIN_LIMITS.minBytes));
    const width = Math.floor(random() * 3000);
    const items = 1 + Math.floor(random() * 30);
    const fake = fakeCall({
      rows: (args) => (args.item === undefined ? items : Math.floor(random() * 5)),
      size: () => width,
      fail: (args) => (args.item !== undefined && random() < 0.4 ? `failed ${"!".repeat(Math.floor(random() * 2000))}` : null),
      answer: (args) => ({ header: [`header ${String(args.item ?? "src").slice(0, 40)} ${"h".repeat(Math.floor(random() * 500))}`] }),
    });
    const value = await run(
      {
        steps: [
          src(),
          { id: "long", from: "src", pick: ["pad", "n"] },
          { id: "per", each: { from: "src", value: "pad" }, read: { name: "t", arguments: { item: { $item: true } } } },
        ],
        return: [{ from: "per" }, { from: "long" }, { from: "src" }],
        max_bytes: maxBytes,
      },
      fake,
    );
    const size = Buffer.byteLength(JSON.stringify(value));
    assert.ok(size <= maxBytes, `round ${round}: ${size} > ${maxBytes}`);
    for (const result of Object.values(value.results)) assert.equal(result.returned + result.cut, result.total);
  }
});

test("E4: an answer whose issues and headers alone are over max_bytes is reduced to fit", async () => {
  const fake = fakeCall({
    rows: (args) => (args.item === undefined ? 20 : 1),
    fail: (args) => (args.item !== undefined && args.item % 2 === 0 ? "x".repeat(3000) : null),
    answer: (args) => ({ header: [`header ${args.item ?? "src"} ${"h".repeat(800)}`] }),
  });
  // Distinct failure codes so the issues cannot be merged by code alone.
  const call = async (name, args) => {
    const response = await fake.call(name, args);
    if (response?.error) response.error.data.reasonCode = `FAKE_${args.item}`;
    return response;
  };
  const value = await runReadChain(
    { project_root: "P", steps: [src(), per()], return: [{ from: "per" }], max_bytes: READ_CHAIN_LIMITS.minBytes },
    { resolveTarget: fakeTarget, call },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= READ_CHAIN_LIMITS.minBytes, `${Buffer.byteLength(JSON.stringify(value))}`);
  assert.ok(value.headerOmitted !== undefined || value.headersOmitted !== undefined, "headers were reduced");
  assert.ok(value.issues.every((issue) => issue.message === undefined));
});

test("E4: with a real tool and long handed-over items the answer stays within max_bytes", async (t) => {
  const f = graphProject(t);
  for (const maxBytes of [READ_CHAIN_LIMITS.minBytes, 6000, 16 * 1024]) {
    const value = answer(
      await chain({
        project_root: f.root,
        steps: [
          { id: "found", read: { name: QUERY, arguments: { question: "find", text: "main window save" } } },
          { id: "again", each: { from: "found", value: "text" }, read: { name: QUERY, arguments: { question: "node", id: { $item: true } } } },
        ],
        return: [{ from: "found" }, { from: "again" }],
        max_bytes: maxBytes,
      }),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, `${maxBytes}`);
    assert.equal(value.everythingSeen, false);
  }
});

// ---------- T5.4 and E3: failures and what is known ----------

test("T5.4, E3: a failed or refused inner call is recorded once per code and step, never retried, never a row; on_error stop stops", async () => {
  const program = (onError) => ({ steps: [src(), per()], return: [{ from: "per", limit: 0 }], ...(onError ? { on_error: onError } : {}) });
  const failing = () => fakeCall({ rows: 4, fail: (args) => (args.item === 1 ? "boom" : null) });
  const go = failing();
  const continued = await run(program(), go);
  assert.equal(continued.status, "partial");
  assert.equal(continued.everythingSeen, false);
  assert.equal(continued.ran.failed, 1);
  assert.equal(continued.ran.calls, 5);
  assert.equal(go.calls.filter((args) => args.item === 1).length, 1, "not retried");
  assert.deepEqual(
    continued.issues.map((issue) => [issue.code, issue.step, issue.item]),
    [["FAKE_FAILED", "per", "1"]],
  );
  assert.equal(continued.results.per.total, 3 * 4);
  assert.ok(continued.notSeenBecause.includes("INNER_CALL_FAILED"));
  const stopped = await run(program("stop"), failing());
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.ran.calls, 3, "no call after the failed one");
  for (const [mode, code, kind] of [
    ["isError", "CHAIN_INNER_CALL_FAILED", "failed"],
    ["noStructure", "CHAIN_INNER_NOT_AN_ANSWER", "failed"],
    ["none", "CHAIN_INNER_NO_RESPONSE", "failed"],
    ["refused", "FAKE_REFUSED", "refused"],
  ]) {
    const value = await run({ steps: [src()], return: [{ from: "src" }] }, fakeCall({ fail: () => mode }));
    assert.deepEqual([value.issues[0].code, value.issues[0].kind, value.results.src.total, value.everythingSeen], [code, kind, 0, false], mode);
  }
  // An item the target refuses gets no call and is counted as refused.
  const perItem = await run(
    { steps: [src(), per({}, { value: "tag" })], return: [{ from: "per", limit: 0 }] },
    fakeCall({ rows: 0, answer: (args) => (args.item === undefined ? { rows: [{ tag: "a" }, { tag: "refuse-me" }, { tag: "b" }] } : {}) }),
  );
  assert.deepEqual([perItem.ran.calls, perItem.ran.refused, perItem.issues[0].code, perItem.issues[0].item], [3, 1, "CHAIN_TOOL_NOT_CHAINABLE", "refuse-me"]);
  assert.ok(perItem.notSeenBecause.includes("INNER_CALL_REFUSED"));
  // A return limit cuts rows: counted, and not everything was seen.
  const limited = await run({ steps: [src()], return: [{ from: "src", limit: 2 }] }, fakeCall({ rows: 3 }));
  assert.deepEqual([limited.results.src.returned, limited.results.src.cut, limited.status, limited.everythingSeen], [2, 1, "completed", false]);
  assert.deepEqual(limited.notSeenBecause, ["ROWS_CUT"]);
  // A basis change on a later page stops the chain even when the build identity is the same.
  const pageBasis = await run(
    { steps: [src({ pages: 3 })], return: [{ from: "src" }] },
    fakeCall({ rows: 6, pageSize: 2, answer: (args, count) => ({ build: "same", ...(count === 2 ? { status: "basis-changed", code: "FAKE_BASIS" } : {}) }) }),
  );
  assert.deepEqual([pageBasis.status, pageBasis.results.src.rows], ["stopped", []]);
  assert.ok(pageBasis.issues.some((issue) => issue.code === "CHAIN_BUILD_CHANGED"));
  const cut = await run({ steps: [src()], return: [{ from: "src" }] }, fakeCall({ answer: () => ({ truncated: true, omitted: 7 }) }));
  assert.deepEqual([cut.notSeen.cutByTool, cut.everythingSeen], [7, false]);
  const take = await run({ steps: [src({ take: "nowhere" })], return: [{ from: "src" }] }, fakeCall());
  assert.ok(take.issues.some((issue) => issue.code === "CHAIN_TAKE_NOT_A_LIST"));
  assert.equal(take.everythingSeen, false);
  const headers = await run(
    { steps: [src(), per()], return: [{ from: "per", limit: 0 }] },
    fakeCall({ rows: 2, answer: (args) => ({ header: [`h ${args.item ?? "src"}`] }) }),
  );
  assert.deepEqual(
    headers.headers.map((entry) => entry.header[0]),
    ["h src", "h 0", "h 1"],
  );
  assert.deepEqual(headers.header, []);
});

test("E3: real answers that are not answers or are cut are never counted as complete", async (t) => {
  const f = fixture(t);
  const notBuilt = answer(await chain(single(f.root, QUERY)));
  assert.deepEqual(
    [notBuilt.status, notBuilt.ran.failed, notBuilt.issues[0].code, notBuilt.results.s.total, notBuilt.everythingSeen],
    ["partial", 1, "PRODUCT_GRAPH_NOT_BUILT", 0, false],
  );
  const g = graphProject(t);
  const refused = answer(await chain(single(g.root, QUERY, { question: "up", id: "no-such-node" })));
  assert.deepEqual([refused.ran.refused, refused.issues[0].kind, refused.everythingSeen], [1, "refused", false]);
  assert.match(refused.issues[0].code, /^PRODUCT_GRAPH_/);
  const direct = answer(await read("lode_project_graph", { project_root: g.root, max_nodes: 1 }));
  assert.ok(direct.truncated === true || direct.omittedMatchCount > 0, "the tool says it cut");
  const cut = answer(await chain(single(g.root, "lode_project_graph", { max_nodes: 1 })));
  assert.equal(cut.everythingSeen, false);
  assert.ok(cut.notSeen.cutByTool > 0);
});

// ---------- T5.3: one build ----------

test("T5.3: a rebuild, a basis change on a later page or a baseline move between calls stops the chain with no content of either build", async (t) => {
  const f = graphProject(t);
  const checkFile = path.join(f.family, "build", "check.json");
  const twoSteps = [
    { id: "a", read: { name: QUERY, arguments: { question: "find", text: "save" } } },
    { id: "b", read: { name: QUERY, arguments: { question: "changes", list: "changed" } } },
  ];
  const between = (change) => {
    let calls = 0;
    return async (name, args) => {
      const response = await read(name, args);
      calls += 1;
      if (calls === 1) change();
      return response;
    };
  };
  const rebuilt = await runReadChain(
    {
      project_root: f.root,
      steps: [{ id: "first", read: { name: QUERY, arguments: { question: "up", id: "no-such-node-marker" } } }, ...twoSteps],
      return: [{ from: "a" }, { from: "b" }],
    },
    {
      resolveTarget: chainReadTarget,
      call: between(() => {
        fs.writeFileSync(f.window, `${fs.readFileSync(f.window, "utf8")}\n# rebuilt\n`);
        buildProductGraph({ root: f.root });
      }),
    },
  );
  assert.equal(rebuilt.status, "stopped");
  assert.deepEqual([rebuilt.results.a.rows, rebuilt.results.b.rows, rebuilt.header], [[], [], []]);
  assert.ok(rebuilt.issues.every((issue) => issue.item === undefined && (issue.code === "CHAIN_BUILD_CHANGED" || issue.message === undefined)));
  assert.equal(JSON.stringify(rebuilt).includes("main_window"), false, "no row text of either build");
  assert.equal(JSON.stringify(rebuilt).includes("no-such-node-marker"), false, "no message of an earlier refusal");
  assert.ok(
    rebuilt.issues.some((issue) => issue.kind === "refused"),
    "the earlier refusal is still counted",
  );
  const paged = await runReadChain(single(f.root, QUERY, { question: "changes", list: "neverChecked", limit: 2 }, { pages: 3 }), {
    resolveTarget: chainReadTarget,
    call: between(() => {
      fs.writeFileSync(f.window, `${fs.readFileSync(f.window, "utf8")}\n# again\n`);
      buildProductGraph({ root: f.root });
    }),
  });
  assert.equal(paged.status, "stopped");
  assert.deepEqual(paged.results.s.rows, []);
  const checkBefore = fs.readFileSync(checkFile);
  const before = answer(await read(QUERY, { project_root: f.root, question: "changes" }));
  const moved = await runReadChain(
    { project_root: f.root, steps: twoSteps, return: [{ from: "a" }, { from: "b" }] },
    { resolveTarget: chainReadTarget, call: between(() => moveProductGraphBaseline({ root: f.root })) },
  );
  assert.deepEqual(fs.readFileSync(checkFile), checkBefore, "the move did not touch check.json");
  const after = answer(await read(QUERY, { project_root: f.root, question: "changes" }));
  assert.notEqual(after.buildSha256, before.buildSha256, "the baseline is part of the identity");
  assert.notDeepEqual(after.header, before.header, "the answers differ after the move");
  assert.equal(moved.status, "stopped");
  assert.ok(moved.issues.some((issue) => issue.code === "CHAIN_BUILD_CHANGED"));
  // A wrong expected_basis_sha256 on the very first call is that call's own failure.
  const wrong = answer(await chain(single(f.root, QUERY, { question: "changes", list: "changed", expected_basis_sha256: "0".repeat(64) })));
  assert.deepEqual([wrong.status, wrong.issues[0].code, wrong.ran.failed], ["partial", "PRODUCT_GRAPH_QUERY_BASIS_CHANGED", 1]);
});

// ---------- E5: cancellation in the real server ----------

test("E5: a cancellation notice reaches a running chain in the stdio server; no further inner call is made", async (t) => {
  const f = graphProject(t);
  const each = (id) => ({ id, each: { from: "src", value: "id" }, read: { name: QUERY, arguments: { question: "node", id: { $item: true } } } });
  const program = {
    project_root: f.root,
    steps: [
      { id: "src", read: { name: QUERY, arguments: { question: "changes", list: "neverChecked", limit: 500 } } },
      each("a"),
      each("b"),
      each("c"),
      each("d"),
    ],
    return: [{ from: "d", limit: 0 }],
  };
  const server = spawn(process.execPath, [path.join(pluginRoot, "scripts", "mcp-server.mjs")], {
    cwd: pluginRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.stdout.setEncoding("utf8");
  let buffer = "";
  const waiting = new Map();
  const replyTo = (id) => new Promise((resolve) => waiting.set(id, resolve));
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    }
  });
  // A first chain loads every module, so the second one has no pause of its own.
  const warm = replyTo("warm");
  const warmProgram = { ...program, steps: program.steps.slice(0, 2), return: [{ from: "a", limit: 0 }] };
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "warm", method: "tools/call", params: { name: "lode_tools_read_chain", arguments: warmProgram } })}\n`,
  );
  assert.equal((await warm).result.structuredContent.status, "completed");
  const reply = replyTo("chain");
  // The whole chain would make 1 + 4 × 9 calls; the notice follows right after the request.
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "chain", method: "tools/call", params: { name: "lode_tools_read_chain", arguments: program } })}\n`,
  );
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "chain" } })}\n`);
  const value = (await reply).result.structuredContent;
  server.stdin.end();
  server.kill();
  await exited;
  assert.equal(value.status, "stopped");
  assert.ok(value.issues.some((issue) => issue.code === "CHAIN_CANCELLED"));
  assert.ok(value.ran.calls < 5, `calls ${value.ran.calls}`);
});

test("T5.7: a cancelled signal makes no further inner call", async () => {
  const controller = new AbortController();
  const fake = fakeCall({ rows: 5, onCall: (count) => count === 2 && controller.abort() });
  const value = await run({ steps: [src(), per()], return: [{ from: "per" }] }, fake, { signal: controller.signal });
  assert.equal(value.status, "stopped");
  assert.equal(fake.calls.length, 2);
});

// ---------- E1 and E2: the same caller, nothing kept ----------

const codex = (bridge, name, args, meta) =>
  dispatch(
    { jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { ...(meta ? { _meta: meta } : {}), name, arguments: args } },
    { nativeSessionBridge: bridge },
  );
const hostEnvironment = (base, guard) => ({
  HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"),
  LODE_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"),
  LODE_SUBAGENT_WRITE_GUARD: guard,
});

test("E1: a chain over any read-only tool leaves the caller's held basis and direction as they were", async (t) => {
  const f = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment: hostEnvironment(f.base, "off") });
  t.after(() => bridge.dispose());
  const meta = { threadId: "thread-A" };
  const direction = { purpose: "p", approved_decisions: ["d"], current_position: "c", next_expected_result: "n" };
  const syncBefore = await codex(bridge, "lode_checkpoint_sync", { project_root: f.root, ...direction }, meta);
  assert.equal(syncBefore.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  const goal = (text) => ({ direction: { goal: text, constraints: [], decisions: [], cancelledActions: [] } });
  answer(
    await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lode_project_direction_update", arguments: { project_root: f.root, expected_direction_id: null, ...goal("set elsewhere") } },
    }),
  );
  const blind = await codex(bridge, "lode_project_direction_update", { project_root: f.root, ...goal("blind") }, meta);
  assert.equal(blind.error.data.reasonCode, "PROJECT_DIRECTION_CONFLICT");
  const held = bridge.recoveryBasisStatus();
  for (const tool of operationCatalogTools.filter((entry) => entry.annotations?.readOnlyHint === true)) {
    const value = answer(
      await codex(
        bridge,
        "lode_tools_read_chain",
        { project_root: f.root, steps: [{ id: "s", read: { name: tool.name, arguments: {} } }], return: [{ from: "s", limit: 0 }] },
        meta,
      ),
    );
    assert.ok(["refused", "partial", "completed"].includes(value.status), tool.name);
    assert.deepEqual(bridge.recoveryBasisStatus(), held, `${tool.name} changed what is held`);
  }
  const syncAfter = await codex(bridge, "lode_checkpoint_sync", { project_root: f.root, ...direction }, meta);
  assert.equal(syncAfter.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  const stillBlind = await codex(bridge, "lode_project_direction_update", { project_root: f.root, ...goal("still blind") }, meta);
  assert.equal(stillBlind.error.data.reasonCode, "PROJECT_DIRECTION_CONFLICT");
});

test("E2: only the declared tools are inner calls, and their inner result equals a direct lode_tools_read of the same caller through the bridge", async (t) => {
  const readOnly = operationCatalogTools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
  const chainable = readOnly.filter((name) => chainReadTarget(name, {}).ok);
  assert.deepEqual(chainable.sort(), [...CHAINABLE].sort());
  for (const name of readOnly.filter((entry) => !CHAINABLE.includes(entry))) assert.equal(chainReadTarget(name, {}).code, "CHAIN_TOOL_NOT_CHAINABLE", name);
  assert.equal(chainReadTarget("lode_product_graph", { action: "query" }).ok, true);
  assert.equal(chainReadTarget("lode_product_graph", { action: "check" }).code, "CHAIN_TOOL_NOT_CHAINABLE");
  for (const name of readOnly) assert.equal(Boolean(chainCompletenessFor(name)), CHAINABLE.includes(name), name);

  const f = graphProject(t);
  const environment = hostEnvironment(f.base, "enforce");
  const reads = [
    [QUERY, { question: "find", text: "save" }, "rows"],
    [QUERY, { question: "up", id: SAVE }, "rows"],
    ["lode_project_graph", { max_nodes: 4 }, "nodes"],
  ];
  const codexBridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => codexBridge.dispose());
  for (const meta of [{ threadId: "thread-main" }, { threadId: "thread-child", agentId: "agent-1" }, null]) {
    for (const [name, args, list] of reads) {
      const direct = answer(await codex(codexBridge, "lode_tools_read", { name, arguments: { project_root: f.root, ...args } }, meta));
      const inner = answer(await codex(codexBridge, "lode_tools_read_chain", single(f.root, name, args), meta));
      assert.deepEqual(inner.results.s.rows, direct[list], `${name} for ${JSON.stringify(meta)}`);
    }
  }
  const claude = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => claude.dispose());
  let n = 0;
  const call = async (name, args, agent) => {
    const id = `use-${++n}`;
    const prepared = await dispatch(
      {
        jsonrpc: "2.0",
        id: "hook",
        method: "tools/call",
        params: {
          name: SESSION_HOST_REQUEST_HELPER,
          arguments: {
            native_session_id: "claude-session",
            native_agent_id: agent,
            tool_use_id: id,
            outer_tool_name: `mcp__lode__${name}`,
            original_arguments: JSON.stringify(args),
            native_project_root: f.root,
          },
        },
      },
      { nativeSessionBridge: claude },
    );
    assert.notEqual(prepared.result?.isError, true, JSON.stringify(prepared));
    return answer(
      await dispatch(
        { jsonrpc: "2.0", id, method: "tools/call", params: { _meta: { "claudecode/toolUseId": id }, name, arguments: args } },
        { nativeSessionBridge: claude },
      ),
    );
  };
  for (const agent of ["", "agent-7"])
    for (const [name, args, list] of reads) {
      const direct = await call("lode_tools_read", { name, arguments: { project_root: f.root, ...args } }, agent);
      const inner = await call("lode_tools_read_chain", single(f.root, name, args), agent);
      assert.deepEqual(inner.results.s.rows, direct[list], `${name} for claude ${agent || "main"}`);
    }
});

// ---------- T7: CLI ----------

test("T7: tools-read-chain gives the same answer as the MCP router, and the same refusal", async (t) => {
  const f = graphProject(t);
  const input = {
    steps: [
      { id: "find", read: { name: QUERY, arguments: { question: "find", text: "save" } } },
      { id: "code", from: "find", where: { field: "nodeType", eq: "코드" } },
      { id: "ids", from: "code", pick: ["id", "changedSinceBaseline"] },
    ],
    return: [{ from: "ids" }],
  };
  const file = path.join(f.base, "chain.json");
  fs.writeFileSync(file, JSON.stringify(input));
  const cli = await runCommand(["tools-read-chain", f.root, "--input", file]);
  const mcp = answer(await chain({ project_root: path.resolve(f.root), ...input }));
  assert.deepEqual(cli, mcp);
  assert.deepEqual(cli.results.ids.rows, [{ id: SAVE_CODE, changedSinceBaseline: "changed" }]);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...input, steps: [{ id: "x", read: { name: "lode_session_work_record", arguments: {} } }], return: [{ from: "x" }] }),
  );
  assert.equal((await runCommand(["tools-read-chain", f.root, "--input", file])).status, "refused");
  fs.writeFileSync(file, JSON.stringify({ ...input, project_root: path.join(f.base, "elsewhere") }));
  await assert.rejects(runCommand(["tools-read-chain", f.root, "--input", file]), { code: "CHAIN_PROJECT_ROOT_MISMATCH" });
});

// ---------- R1 ----------

test("R1: no product graph tool's structuredContent carries text that its structured part gives back; the content text and the CLI keep it", async (t) => {
  const f = graphProject(t);
  const questions = [
    { question: "overview" },
    { question: "node", id: SAVE },
    { question: "down", id: SAVE },
    { question: "up", id: SAVE },
    { question: "reach", id: SAVE },
    { question: "find", text: "save" },
    { question: "gaps" },
    { question: "changes" },
    { question: "changes", list: "reviewAgain" },
    { question: "changes", list: "content", limit: 1 },
    { question: "changes", list: "neverChecked", limit: 2 },
    { question: "impact" },
  ];
  for (const args of questions) {
    const response = await read(QUERY, { project_root: f.root, ...args });
    const structured = answer(response);
    const core = queryProductGraph({ root: f.root, ...args });
    assert.equal(structured.text, undefined, JSON.stringify(args));
    assert.equal(typeof core.text, "string");
    assert.equal(response.result.content[0].text, formatMcpToolContent(QUERY, core), "the content text is unchanged");
    const rebuilt =
      [
        ...structured.header,
        structured.title,
        ...structured.rows.map((row) => `${"  ".repeat(row.depth)}${row.detail?.before || row.detail?.after ? walk.contentItemText(row.detail) : row.text}`),
      ].join("\n") + "\n";
    assert.equal(rebuilt, core.text, `${JSON.stringify(args)}: the structured part gives the text back exactly`);
    if (structured.page?.nextMcpArguments) assert.equal(answer(await read(QUERY, structured.page.nextMcpArguments)).text, undefined, "a later page");
  }
  const content = answer(await read(QUERY, { project_root: f.root, question: "changes", list: "content", limit: 1 }));
  assert.ok(
    content.rows.some((row) => row.detail),
    "the content list has items",
  );
  const check = answer(await read("lode_product_graph_check", { project_root: f.root }));
  assert.equal(check.text, undefined);
  assert.equal(renderProductGraphText(check), checkProductGraph({ root: f.root }).text);
  for (const name of ["lode_product_graph_build", "lode_product_graph_baseline"]) {
    const response = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lode_tools_call", arguments: { name, arguments: { project_root: f.root } } },
    });
    assert.equal(answer(response).text, undefined, name);
    assert.ok(response.result.content[0].text.length > 0);
  }
  // A not-built answer: its sentence is only in text and message, and it keeps text.
  const empty = fixture(t);
  assert.equal(typeof answer(await read(QUERY, { project_root: empty.root })).text, "string");
});

// ---------- R2 ----------

test("R2: node rows carry type, change since the baseline and the confirmation lists that name them; the row text is the walk's own", async (t) => {
  const f = graphProject(t, { confirm: true });
  const node = async (id) => answer(await read(QUERY, { project_root: f.root, question: "node", id })).rows.find((row) => row.depth === 0);
  const changed = await node(SAVE_CODE);
  assert.deepEqual([changed.nodeType, changed.changedSinceBaseline], ["코드", "changed"]);
  const checked = await node(SAVE);
  assert.deepEqual([checked.nodeType, checked.changedSinceBaseline, checked.confirmation], ["기능", "reachChanged", ["neverChecked", "changedSinceCheck"]]);
  for (const id of ["MAIN-01", "MAIN-01#1"]) {
    const row = await node(id);
    assert.ok(row.confirmation?.includes("neverChecked"), `${id}: ${JSON.stringify(row)}`);
  }
  const listed = answer(await read(QUERY, { project_root: f.root, question: "changes", list: "neverChecked", limit: 500 }));
  for (const row of listed.rows.filter((entry) => entry.kind === "node")) assert.ok(row.confirmation.includes("neverChecked"), row.id);
  assert.equal(listed.confirmationComparison, "compared");
  fs.appendFileSync(f.window, "\n\ndef brand_new_helper():\n    return 1\n");
  const meaning = path.join(f.family, "기능 뜻.md");
  fs.writeFileSync(meaning, fs.readFileSync(meaning, "utf8").replace("지금 상태를 저장한다", "지금 상태를 파일로 저장한다"));
  buildProductGraph({ root: f.root });
  const added = answer(await read(QUERY, { project_root: f.root, question: "changes", list: "added", limit: 500 })).rows.filter((row) => row.kind === "node");
  assert.ok(added.length && added.every((row) => row.changedSinceBaseline === "added"), JSON.stringify(added));
  assert.ok((await node(SAVE)).confirmation.includes("textChanged"));
  const built = readProductGraphBuild({ root: f.root });
  const walked = walk.ask(productGraphQueryContext(built), {
    question: "node",
    id: SAVE,
    text: "",
    list: null,
    limit: walk.LIMIT,
    cursor: 0,
    depth: 1,
    nodeTypes: [],
    relatedTo: null,
    edgeTypes: [],
    basisStates: [],
  });
  assert.deepEqual(
    answer(await read(QUERY, { project_root: f.root, question: "node", id: SAVE })).rows.map((row) => row.text),
    walked.rows.map((row) => row.text),
  );
  const starts = answer(await read(QUERY, { project_root: f.root, question: "overview" })).rows.filter((row) => row.kind === "node");
  assert.ok(starts.length && starts.every((row) => row.id.startsWith("@") && row.nodeType === undefined));
  const checkFile = path.join(f.family, "build", "check.json");
  const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
  delete check.confirmations;
  delete check.changes;
  fs.writeFileSync(checkFile, `${JSON.stringify(check, null, 2)}\n`);
  const bare = answer(await read(QUERY, { project_root: f.root, question: "node", id: SAVE }));
  assert.equal(bare.confirmationComparison, "absent");
  assert.equal(Object.hasOwn(bare.rows[0], "changedSinceBaseline"), false);
  assert.equal(Object.hasOwn(bare.rows[0], "confirmation"), false);
});

test("R2: a stand-alone build says its confirmations were not read", (t) => {
  const f = fixture(t);
  const source = path.join(f.base, "source");
  fs.cpSync(path.join(fixtures, "ui-signal"), source, { recursive: true });
  const out = path.join(f.base, "out");
  fs.mkdirSync(path.join(f.base, "docs"));
  buildProductGraph({
    sourceRoot: source,
    documentsDirectory: path.join(f.base, "docs"),
    rulesFile: path.join(fixtures, "empty-rules.json"),
    outputDirectory: out,
  });
  const value = queryProductGraph({ sourceRoot: source, buildDirectory: out, question: "node", id: SAVE_CODE });
  assert.equal(value.status, "answered");
  assert.equal(value.confirmationComparison, "not-read");
});

// ---------- buildSha256 ----------

test("A5: buildSha256 names every build an answer read; it is on refusals and basis changes; a check.json change moves it, a no-op rebuild does not", async (t) => {
  const f = graphProject(t);
  const id = async (args) => answer(await read(QUERY, { project_root: f.root, ...args })).buildSha256;
  const values = [];
  for (const question of ["overview", "gaps", "changes", "find"]) values.push(await id({ question, ...(question === "find" ? { text: "save" } : {}) }));
  assert.ok(values.every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(new Set(values).size, 1, "the same build for every plain question");
  assert.equal(await id({ question: "find", text: "x", related_to: "no-such" }), values[0], "on a refusal");
  assert.equal(await id({ question: "changes", list: "changed", expected_basis_sha256: "0".repeat(64) }), values[0], "on basis-changed");
  buildProductGraph({ root: f.root });
  assert.equal(await id({ question: "overview" }), values[0], "a rebuild that writes the same bytes keeps it");
  const checkFile = path.join(f.family, "build", "check.json");
  fs.writeFileSync(checkFile, fs.readFileSync(checkFile, "utf8").replace(/\n$/, "\n\n"));
  assert.notEqual(await id({ question: "overview" }), values[0], "a check.json-only change moves it");
  buildProductGraph({ root: f.root });
  const candidate = path.join(f.base, "candidate");
  fs.cpSync(path.join(f.family, "build"), candidate, { recursive: true });
  const first = await id({ question: "impact", candidate_build: candidate });
  assert.notEqual(first, await id({ question: "impact" }), "the candidate is part of what an impact answer read");
  const graphFile = path.join(candidate, "graph.json");
  fs.writeFileSync(graphFile, fs.readFileSync(graphFile, "utf8").replace(/\n$/, "\n\n"));
  assert.notEqual(await id({ question: "impact", candidate_build: candidate }), first);
});

// ---------- R3 ----------

test("R3: resultShape is returned by exact name, every declared field occurs in real answers, and the completeness declarations hold", async (t) => {
  const f = graphProject(t);
  const shapes = {};
  for (const name of RESULT_SHAPE_TOOLS) {
    const found = answer(await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_discover", arguments: { name } } }));
    shapes[name] = found.tools[0].resultShape;
    assert.deepEqual(shapes[name], resultShapeFor(name), name);
    assert.equal(shapes[name].chainable, CHAINABLE.includes(name));
  }
  const prefix = answer(
    await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_discover", arguments: { prefix: "lode_project_" } } }),
  );
  assert.ok(
    prefix.tools.every((tool) => tool.resultShape === undefined),
    "only by exact name",
  );
  const at = (value, dotted) => dotted.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
  const query = shapes[QUERY];
  const seenFields = new Set();
  const seenKinds = new Set();
  const known = new Set([...query.rowFields.always, ...query.rowFields.nodeRows, ...query.rowFields.sometimes]);
  const questions = [
    { question: "overview" },
    { question: "node", id: SAVE },
    { question: "down", id: SAVE },
    { question: "up", id: SAVE },
    { question: "reach", id: SAVE },
    { question: "find", text: "save" },
    { question: "gaps" },
    { question: "changes" },
    { question: "changes", list: "content" },
    { question: "changes", list: "neverChecked", limit: 2 },
    { question: "impact" },
  ];
  for (const args of questions) {
    const value = answer(await read(QUERY, { project_root: f.root, ...args }));
    assert.ok(Array.isArray(at(value, query.rows)), JSON.stringify(args));
    for (const dotted of Object.values(query.build)) assert.notEqual(at(value, dotted), undefined, dotted);
    for (const row of value.rows) {
      for (const field of query.rowFields.always) assert.ok(Object.hasOwn(row, field), field);
      for (const field of Object.keys(row)) {
        assert.ok(known.has(field), `${field} of ${JSON.stringify(args)}`);
        seenFields.add(field);
      }
      seenKinds.add(row.kind);
      if (row.changedSinceBaseline) assert.ok(query.fieldValues.changedSinceBaseline.includes(row.changedSinceBaseline));
      for (const key of row.confirmation || []) assert.ok(query.fieldValues.confirmation.includes(key));
    }
    assert.ok(query.fieldValues.confirmationComparison.includes(value.confirmationComparison));
    if (value.page?.remaining) for (const dotted of Object.values(query.paging)) assert.notEqual(at(value, dotted), undefined, dotted);
  }
  // Fields that only other questions or other projects give are named here.
  const notOnFixture = new Set(
    ["exact", "onPath", "marker", "group", "hint", "edge", "score", "matchedTerms", "detail"].filter((field) => !seenFields.has(field)),
  );
  for (const field of known) assert.ok(seenFields.has(field) || notOnFixture.has(field), `declared field ${field} occurs`);
  assert.ok(notOnFixture.size <= 2, `${[...notOnFixture]}`);
  assert.deepEqual([...seenKinds].sort(), [...query.rowKinds].sort());
  const graph = answer(await read("lode_project_graph", { project_root: f.root }));
  const graphShape = shapes.lode_project_graph;
  assert.ok(at(graph, graphShape.rows).length > 0);
  for (const row of at(graph, graphShape.rows)) for (const field of graphShape.rowFields.always) assert.ok(Object.hasOwn(row, field), field);
  for (const row of at(graph, graphShape.otherLists.edges)) for (const field of graphShape.rowFields.edges) assert.ok(Object.hasOwn(row, field), field);
  for (const dotted of Object.values(graphShape.paging)) assert.notEqual(at(graph, dotted), undefined, dotted);
  const inventory = answer(await read("lode_project_graph", { project_root: f.root, inventory_page: true }));
  const mode = graphShape.modes.inventory;
  assert.ok(Array.isArray(at(inventory, mode.rows)) && at(inventory, mode.rows).length > 0);
  for (const row of at(inventory, mode.rows)) for (const field of mode.rowFields) assert.ok(Object.hasOwn(row, field), field);
  assert.ok(Object.hasOwn(inventory.inventoryPage, "next"));
  assert.notEqual(at(inventory, mode.coverage), undefined);
  await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "lode_tools_call",
      arguments: { name: "lode_session_work_record", arguments: { project_root: f.root, evidence: { summary: "s", workTopics: ["t"] } } },
    },
  });
  const work = answer(await read("lode_session_work_read", { project_root: f.root }));
  const workShape = shapes.lode_session_work_read;
  assert.ok(at(work, workShape.rows).length > 0);
  for (const row of at(work, workShape.rows)) {
    for (const field of workShape.rowFields.always) assert.ok(Object.hasOwn(row, field), field);
    for (const field of workShape.rowFields.content) assert.ok(Object.hasOwn(row.content, field), field);
  }
  assert.ok(Array.isArray(at(work, workShape.otherLists.todos)));
  assert.ok(Object.hasOwn(work, workShape.paging.next));
  // The completeness declarations against real answers.
  const q = chainCompletenessFor(QUERY);
  const matches = (value, spec) =>
    Object.hasOwn(spec, "in")
      ? spec.in.includes(at(value, spec.field))
      : Object.hasOwn(spec, "gt")
        ? at(value, spec.field) > spec.gt
        : at(value, spec.field) === spec.eq;
  assert.ok(matches(answer(await read(QUERY, { project_root: f.root })), q.answered));
  assert.ok(matches(answer(await read(QUERY, { project_root: f.root, question: "up", id: "nope" })), q.refused));
  assert.ok(
    matches(answer(await read(QUERY, { project_root: f.root, question: "changes", list: "changed", expected_basis_sha256: "0".repeat(64) })), q.basisChanged),
  );
  const empty = fixture(t);
  const notBuilt = answer(await read(QUERY, { project_root: empty.root }));
  assert.ok(!matches(notBuilt, q.answered) && typeof at(notBuilt, q.code[0]) === "string");
  const p = chainCompletenessFor("lode_project_graph");
  assert.ok(matches(graph, p.answered));
  const truncated = answer(await read("lode_project_graph", { project_root: f.root, max_nodes: 1 }));
  assert.ok(p.cut.some((spec) => matches(truncated, spec)));
  const fallback = answer(await read("lode_project_graph", { project_root: empty.root, query: "zzz-nothing-matches-this" }));
  if (!matches(fallback, p.answered)) assert.ok(p.code.some((field) => typeof at(fallback, field) === "string"));
});

// ---------- docs ----------

test("docs: the chain examples run as written and the bounds tables quote the constants", async (t) => {
  const f = graphProject(t);
  for (const file of ["docs/mcp-surface.md", "docs/ko/mcp-surface.md", "docs/product-graph-usage.md", "docs/ko/product-graph-usage.md"]) {
    const text = fs.readFileSync(path.join(pluginRoot, file), "utf8");
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((block) => block.includes('"project_root"') && Array.isArray(JSON.parse(block).steps));
    assert.ok(blocks.length > 0, file);
    for (const block of blocks) {
      const input = JSON.parse(block.replaceAll("/path/to/project", "<project>").replaceAll('"<project>"', JSON.stringify(f.root)));
      const value = answer(await chain(input));
      assert.equal(value.status, "completed", `${file}: ${JSON.stringify(value.issues)}`);
      assert.ok(
        Object.values(value.results).some((result) => result.total > 0),
        file,
      );
    }
  }
  const bounds = [
    ["Steps", "단계 수", READ_CHAIN_LIMITS.steps],
    ["Inner calls in total, pages included", "안쪽 호출 합계(쪽 넘김 포함)", READ_CHAIN_LIMITS.calls],
    ["Calls of one `each`, pages included", "`each` 한 번의 호출(쪽 넘김 포함)", READ_CHAIN_LIMITS.eachCalls],
    ["Pages of one `read`", "`read` 한 번의 쪽", READ_CHAIN_LIMITS.pages],
    ["Values of one `in`", "`in` 하나의 값", READ_CHAIN_LIMITS.inValues],
    ["Fields of one `pick`", "`pick` 하나의 필드", READ_CHAIN_LIMITS.pickFields],
    ["Parts of a field path", "필드 경로의 부분", READ_CHAIN_LIMITS.pathSegments],
    ["Nesting of `all` / `any`", "`all` / `any` 겹침", READ_CHAIN_LIMITS.conditionDepth],
    ["Nesting of the input", "입력의 겹침", READ_CHAIN_LIMITS.nestingDepth],
  ];
  const kib = (value) => `${value / 1024} KiB`;
  for (const [file, column] of [
    ["docs/mcp-surface.md", 0],
    ["docs/ko/mcp-surface.md", 1],
  ]) {
    const text = fs.readFileSync(path.join(pluginRoot, file), "utf8");
    for (const row of bounds) assert.ok(text.includes(`| ${row[column]} | ${row[2]} |`), `${file}: ${row[column]}`);
    for (const value of [
      kib(READ_CHAIN_LIMITS.minBytes),
      kib(READ_CHAIN_LIMITS.defaultBytes),
      kib(READ_CHAIN_LIMITS.maxBytes),
      kib(READ_CHAIN_LIMITS.inputBytes),
      `${READ_CHAIN_LIMITS.memoryBytes / 1024 / 1024} MiB`,
    ])
      assert.ok(text.includes(value), `${file}: ${value}`);
  }
});
