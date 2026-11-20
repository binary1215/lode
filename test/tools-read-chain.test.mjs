// lode_tools_read_chain: a declarative chain of read-only calls run inside the
// server, and the product graph answer changes that go with it (R1-R3).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { buildProductGraph, confirmProductGraph, moveProductGraphBaseline } from "../scripts/lib/world/product-graph.mjs";
import { chainReadTarget, dispatch, tools, toolsForSurface } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { READ_CHAIN_LIMITS, READ_CHAIN_REFERENCE, runReadChain } from "../scripts/lib/core/tools-read-chain.mjs";
import { RESULT_SHAPE_TOOLS, resultShapeFor } from "../scripts/lib/core/tool-result-shapes.mjs";
import { claudeNativeHookMatchers } from "../scripts/lib/session/session-host-request.mjs";
import { registryCatalog } from "../scripts/lib/session/operation-registry.mjs";
import { formatMcpToolContent } from "../scripts/lib/session/cli-presentation.mjs";

const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
const SAVE = "fe/station/ui/main_window/MainWindow@clicked:_save";
const SAVE_CODE = "station/ui/main_window.py#MainWindow._save";
const QUERY = "lode_product_graph_query";

// The ui-signal fixture, built, with a baseline, then _save edited and built
// again: three code nodes changed, two features reach changed code.
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
  return { ...f, window };
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
const read = async (name, args) =>
  await dispatch({ jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { name: "lode_tools_read", arguments: { name, arguments: args } } });
const chain = async (args, options) =>
  await dispatch({ jsonrpc: "2.0", id: ++ids, method: "tools/call", params: { name: "lode_tools_read_chain", arguments: args } }, options);
const answer = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
};

// A fake tool for the bounds: rows 0..n-1 of the given size, paged.
const fakeTarget = (name) => ({ ok: true, name, operation: name, declaresProjectRoot: true });
function fakeCall({ rows = 3, size = 10, pageSize = null, fail = () => null, onCall = () => {} } = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push(args);
    onCall(calls.length, args);
    const failure = fail(args, calls.length);
    if (failure) return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: failure, data: { reasonCode: "FAKE_FAILED" } } };
    const cursor = args.cursor ?? 0;
    const count = typeof rows === "function" ? rows(args) : rows;
    const width = typeof size === "function" ? size(args) : size;
    const all = Array.from({ length: count }, (_, index) => ({ n: index, pad: "x".repeat(width), item: args.item ?? null }));
    const slice = pageSize ? all.slice(cursor, cursor + pageSize) : all;
    const remaining = pageSize ? Math.max(0, count - cursor - pageSize) : 0;
    const value = { rows: slice, ...(remaining ? { page: { remaining, nextMcpArguments: { ...args, cursor: cursor + pageSize } } } : {}) };
    return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "" }], structuredContent: value } };
  };
  return { call, calls };
}
const run = (input, fake, extra = {}) => runReadChain({ project_root: "P", ...input }, { resolveTarget: fakeTarget, call: fake.call, ...extra });

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
  assert.equal(discovered.tools[0].reference.bounds.innerCallsIncludingPages, 40);
});

// ---------- T5.1: validation before any call ----------

test("T5.1: every invalid program is refused before any inner call, with every problem at once", async (t) => {
  const f = fixture(t);
  const calls = [];
  const target = (name, args) => chainReadTarget(name, args);
  const spy = async (name, args) => {
    calls.push(name);
    return null;
  };
  const step = (id, name, args = {}) => ({ id, read: { name, arguments: args } });
  const cases = [
    ["not read-only", [step("a", "lode_session_work_record")], /not read-only/],
    ["unknown tool", [step("a", "lode_no_such_tool")], /Unknown tool/],
    ["router", [step("a", "lode_tools_read")], /cannot be an inner call/],
    ["the chain itself", [step("a", "lode_tools_read_chain")], /cannot be an inner call/],
    ["discovery", [step("a", "lode_tools_discover")], /cannot be an inner call/],
    ["second project root", [step("a", QUERY, { project_root: path.join(f.root, "other") })], /another project_root/],
    ["unknown step kind", [{ id: "a", frob: {} }], /exactly one of/],
    ["forward reference", [{ id: "a", from: "b", limit: 1 }, step("b", QUERY)], /not an earlier step/],
    ["$item without each", [step("a", QUERY, { id: { $item: true } })], /only in a step with each/],
    ["13 steps", Array.from({ length: 13 }, (_, index) => step(`s${index}`, QUERY)), /at most 12 steps/],
  ];
  for (const [label, steps, pattern] of cases) {
    const value = await runReadChain({ project_root: f.root, steps, return: [{ from: steps[0].id }] }, { resolveTarget: target, call: spy });
    assert.equal(value.status, "refused", label);
    assert.ok(
      value.issues.some((issue) => pattern.test(issue.message)),
      `${label}: ${JSON.stringify(value.issues)}`,
    );
    assert.equal(value.ran.calls, 0, label);
  }
  assert.deepEqual(calls, [], "no inner call ran");
  // All problems at once, through the router.
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
  assert.equal(first.content[0].text, JSON.stringify(value), "the content text is no larger than the JSON");

  // One by one: the pages, the filtering, then one call per node.
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
  for (const row of todo.filter((row) => row.kind === "node")) if (!one.some((seen) => seen.id === row.id)) one.push(row);
  const callers = [];
  for (const row of one) {
    const got = answer(await read(QUERY, { project_root: f.root, question: "up", id: row.id }));
    calls += 1;
    callers.push(...got.rows.map((entry) => ({ ...entry, item: row.id })));
  }
  const callerNodes = callers.filter((row) => row.kind === "node" && row.depth >= 1);
  const counts = new Map();
  for (const row of callerNodes) counts.set(row.item, (counts.get(row.item) || 0) + 1);
  const top = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  assert.deepEqual(value.results.callerNodes.rows, callerNodes);
  assert.deepEqual(value.results.top.rows, top.slice(0, 10));
  assert.equal(value.ran.calls, calls);
  assert.deepEqual(value.notSeen, { pagesLeft: 0, itemsLeft: 0, eachSkipped: 0, callsSkipped: 0, rowsDropped: 0 });
  assert.deepEqual(
    value.basis.map((entry) => [entry.tool, entry.pinned]),
    [[QUERY, true]],
  );
  assert.equal(value.header.length, 3, "the repeated header is given once");
  assert.equal(value.headers, undefined);
});

// ---------- T4: bounds ----------

test("T4: each stops at its max and counts the rest; total calls stop at 40 and count the rest", async () => {
  const fake = fakeCall({ rows: 25 });
  const each = await run(
    {
      steps: [
        { id: "src", read: { name: "t", arguments: {} } },
        { id: "per", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
      ],
      return: [{ from: "per", limit: 0 }],
    },
    fake,
  );
  assert.equal(each.ran.calls, 21, "one read and twenty, not twenty-five");
  assert.equal(each.notSeen.eachSkipped, 5);
  assert.equal(each.status, "partial");
  assert.equal(each.results.per.total, 20 * 25);
  const total = await run(
    {
      steps: [
        { id: "src", read: { name: "t", arguments: {} } },
        { id: "a", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
        { id: "b", each: { from: "src", value: "n", max: 20 }, read: { name: "t", arguments: { item: { $item: true } } } },
      ],
      return: [{ from: "b", limit: 0 }],
    },
    fakeCall({ rows: 25 }),
  );
  assert.equal(total.ran.calls, 40);
  assert.equal(total.notSeen.callsSkipped, 1, "the 41st call is counted, not made");
  assert.equal(total.notSeen.eachSkipped, 5 + 5, "rows past each max, in a and in b");
  assert.equal(total.status, "partial");
});

test("T4: pages stop at the asked number and count what was left; returned bytes stop at max_bytes and count the cut; intermediate rows stop at 16 MiB", async () => {
  const paged = await run({ steps: [{ id: "a", read: { name: "t", arguments: {} }, pages: 2 }], return: [{ from: "a" }] }, fakeCall({ rows: 10, pageSize: 3 }));
  assert.equal(paged.ran.calls, 2);
  assert.equal(paged.results.a.total, 6);
  assert.deepEqual([paged.notSeen.pagesLeft, paged.notSeen.itemsLeft], [1, 4]);
  assert.equal(paged.status, "partial");

  const bytes = await run(
    { steps: [{ id: "a", read: { name: "t", arguments: {} } }], max_bytes: 1024, return: [{ from: "a" }] },
    fakeCall({ rows: 50, size: 40 }),
  );
  assert.equal(bytes.status, "partial");
  assert.ok(Buffer.byteLength(JSON.stringify(bytes)) <= 1024);
  assert.equal(bytes.results.a.total, 50);
  assert.equal(bytes.results.a.returned + bytes.results.a.cut, 50);
  assert.ok(bytes.results.a.cut > 0 && bytes.results.a.returned > 0);
  assert.ok(bytes.issues.some((issue) => issue.code === "CHAIN_BYTES_LIMIT"));
  const fits = await run({ steps: [{ id: "a", read: { name: "t", arguments: {} } }], return: [{ from: "a" }] }, fakeCall({ rows: 3 }));
  assert.equal(fits.status, "completed");
  assert.equal(fits.results.a.cut, 0);

  // One row of 1 MiB per call: past 16 MiB the row is dropped and no further call is made.
  const memory = await run(
    {
      steps: [
        { id: "src", read: { name: "t", arguments: {} } },
        { id: "big", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
      ],
      return: [{ from: "big", limit: 0 }],
    },
    fakeCall({ rows: (args) => (args.item === undefined ? 20 : 1), size: (args) => (args.item === undefined ? 1 : 1024 * 1024) }),
  );
  assert.equal(memory.status, "partial");
  assert.equal(memory.results.big.total, 15);
  assert.deepEqual([memory.notSeen.rowsDropped, memory.notSeen.callsSkipped], [1, 4]);
  assert.equal(memory.ran.calls, 1 + 16);
  assert.ok(memory.issues.some((issue) => issue.code === "CHAIN_MEMORY_LIMIT"));
});

// ---------- T5.4: failures ----------

test("T5.4: a failed inner call is recorded on its item and the chain continues; on_error stop stops; nothing is retried", async () => {
  const program = (onError) => ({
    steps: [
      { id: "src", read: { name: "t", arguments: {} } },
      { id: "per", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
    ],
    return: [{ from: "per", limit: 0 }],
    ...(onError ? { on_error: onError } : {}),
  });
  const failing = () => fakeCall({ rows: 4, fail: (args) => (args.item === 1 ? "boom" : null) });
  const go = failing();
  const continued = await run(program(), go);
  assert.equal(continued.status, "partial");
  assert.equal(continued.ran.failed, 1);
  assert.equal(continued.ran.calls, 5);
  assert.equal(go.calls.filter((args) => args.item === 1).length, 1, "not retried");
  assert.deepEqual(
    continued.issues.map((issue) => [issue.code, issue.step, issue.item]),
    [["FAKE_FAILED", "per", 1]],
  );
  assert.equal(continued.results.per.total, 3 * 4);
  const halt = failing();
  const stopped = await run(program("stop"), halt);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.ran.calls, 3, "no call after the failed one");
  assert.ok(stopped.issues.some((issue) => issue.code === "CHAIN_STOPPED_ON_ERROR"));
});

test("T5.4: a refused product graph answer is recorded as refused with its code", async (t) => {
  const f = graphProject(t);
  const value = answer(
    await chain({
      project_root: f.root,
      steps: [{ id: "a", read: { name: QUERY, arguments: { question: "up", id: "no-such-node" } } }],
      return: [{ from: "a" }],
    }),
  );
  assert.equal(value.status, "partial");
  assert.equal(value.ran.refused, 1);
  assert.equal(value.issues[0].kind, "refused");
  assert.match(value.issues[0].code, /^PRODUCT_GRAPH_/);
});

// ---------- T5.3: one build ----------

test("T5.3: a build that changes between two inner calls stops the chain; nothing from the two builds is returned", async (t) => {
  const f = graphProject(t);
  const steps = [
    { id: "a", read: { name: QUERY, arguments: { question: "overview" } } },
    { id: "b", read: { name: QUERY, arguments: { question: "changes", list: "changed" } } },
  ];
  let calls = 0;
  const call = async (name, args) => {
    const response = await read(name, args);
    calls += 1;
    if (calls === 1) {
      fs.writeFileSync(f.window, `${fs.readFileSync(f.window, "utf8")}\n# rebuilt\n`);
      buildProductGraph({ root: f.root });
    }
    return response;
  };
  const value = await runReadChain({ project_root: f.root, steps, return: [{ from: "a" }, { from: "b" }] }, { resolveTarget: chainReadTarget, call });
  assert.equal(value.status, "stopped");
  assert.ok(value.issues.some((issue) => issue.code === "CHAIN_BUILD_CHANGED"));
  assert.deepEqual(value.results.a.rows, []);
  assert.deepEqual(value.results.b.rows, []);
  // A next page asked after a rebuild is reported by the tool as basis-changed: also stopped.
  let paged = 0;
  const pageCall = async (name, args) => {
    const response = await read(name, args);
    paged += 1;
    if (paged === 1) {
      fs.writeFileSync(f.window, `${fs.readFileSync(f.window, "utf8")}\n# again\n`);
      buildProductGraph({ root: f.root });
    }
    return response;
  };
  const pages = await runReadChain(
    {
      project_root: f.root,
      steps: [{ id: "p", read: { name: QUERY, arguments: { question: "changes", list: "neverChecked", limit: 2 } }, pages: 3 }],
      return: [{ from: "p" }],
    },
    { resolveTarget: chainReadTarget, call: pageCall },
  );
  assert.equal(pages.status, "stopped");
  assert.deepEqual(pages.results.p.rows, []);
});

test("T5.3: a baseline move between two inner calls stops the chain too: check.json is unchanged, the answers are not", async (t) => {
  const f = graphProject(t);
  const checkFile = path.join(f.root, ".lode", "context", "product-graph", "build", "check.json");
  const checkBefore = fs.readFileSync(checkFile);
  const before = answer(await read(QUERY, { project_root: f.root, question: "changes" }));
  let calls = 0;
  const call = async (name, args) => {
    const response = await read(name, args);
    calls += 1;
    if (calls === 1) moveProductGraphBaseline({ root: f.root });
    return response;
  };
  const steps = [
    { id: "a", read: { name: QUERY, arguments: { question: "changes" } } },
    { id: "b", read: { name: QUERY, arguments: { question: "changes", list: "changed" } } },
  ];
  const value = await runReadChain({ project_root: f.root, steps, return: [{ from: "a" }, { from: "b" }] }, { resolveTarget: chainReadTarget, call });
  assert.deepEqual(fs.readFileSync(checkFile), checkBefore, "the move did not touch check.json");
  const after = answer(await read(QUERY, { project_root: f.root, question: "changes" }));
  assert.notEqual(after.buildSha256, before.buildSha256, "the baseline is part of the identity");
  assert.notDeepEqual(after.header, before.header, "the answers differ after the move");
  assert.equal(value.status, "stopped");
  assert.ok(value.issues.some((issue) => issue.code === "CHAIN_BUILD_CHANGED"));
  assert.deepEqual([value.results.a.rows, value.results.b.rows], [[], []]);
});

test("T5.7: a cancelled request makes no further inner call", async () => {
  const controller = new AbortController();
  const fake = fakeCall({ rows: 5, onCall: (count) => count === 2 && controller.abort() });
  const value = await run(
    {
      steps: [
        { id: "src", read: { name: "t", arguments: {} } },
        { id: "per", each: { from: "src", value: "n" }, read: { name: "t", arguments: { item: { $item: true } } } },
      ],
      return: [{ from: "per" }],
    },
    fake,
    { signal: controller.signal },
  );
  assert.equal(value.status, "stopped");
  assert.equal(fake.calls.length, 2);
  assert.ok(value.issues.some((issue) => issue.code === "CHAIN_CANCELLED"));
});

// ---------- T5.2: the same route ----------

test("T5.2: inner calls take the lode_tools_read route: a guarded subagent caller can run a chain of reads, and an inner refusal is the one lode_tools_read gives", async (t) => {
  const f = graphProject(t);
  const caller = { runtime: "codex", nativeSessionId: "thread-1", subagent: true, correlation: "codex-subconversation" };
  const value = answer(
    await chain(
      { project_root: f.root, steps: [{ id: "a", read: { name: QUERY, arguments: { question: "overview" } } }], return: [{ from: "a", limit: 1 }] },
      { caller, hostEnvironment: { ...process.env, LODE_SUBAGENT_WRITE_GUARD: "enforce" } },
    ),
  );
  assert.equal(value.status, "completed");
  assert.equal(value.results.a.returned, 1);
  // The operation's own refusal reaches the chain unchanged.
  const direct = await read(QUERY, { project_root: f.root, question: "node" });
  assert.equal(direct.error.data.reasonCode, "PRODUCT_GRAPH_QUERY_INVALID");
  const inner = answer(
    await chain({ project_root: f.root, steps: [{ id: "g", read: { name: QUERY, arguments: { question: "node" } } }], return: [{ from: "g" }] }),
  );
  assert.equal(inner.ran.failed, 1);
  assert.deepEqual([inner.issues[0].code, inner.issues[0].message], [direct.error.data.reasonCode, direct.error.message]);
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

test("R1: structuredContent of a product graph answer has no second copy of its text; the content text and the CLI answer keep it", async (t) => {
  const f = graphProject(t);
  for (const args of [
    { question: "overview" },
    { question: "node", id: SAVE },
    { question: "up", id: SAVE },
    { question: "find", text: "save" },
    { question: "changes", list: "reviewAgain" },
    { question: "changes", list: "neverChecked", limit: 2 },
  ]) {
    const response = await read(QUERY, { project_root: f.root, ...args });
    const structured = answer(response);
    assert.equal(structured.text, undefined, JSON.stringify(args));
    const cli = await runCommand([
      "product-graph-query",
      f.root,
      args.question,
      ...(args.id ? [args.id] : args.text ? [args.text] : []),
      ...(args.list ? ["--list", args.list] : []),
      ...(args.limit ? ["--limit", String(args.limit)] : []),
    ]);
    assert.equal(typeof cli.text, "string", "the CLI JSON keeps the text");
    assert.equal(response.result.content[0].text, formatMcpToolContent(QUERY, cli), "the content text is unchanged");
    const rebuilt = [...structured.header, structured.title, ...structured.rows.map((row) => `${"  ".repeat(row.depth)}${row.text}`)].join("\n") + "\n";
    assert.equal(rebuilt, cli.text, "the rows give the text back exactly");
    assert.ok(Buffer.byteLength(JSON.stringify(structured)) < Buffer.byteLength(JSON.stringify(cli)));
  }
  // An answer whose text says more than its rows keeps it (the before/after content list).
  const content = answer(await read(QUERY, { project_root: f.root, question: "changes", list: "content", limit: 1 }));
  assert.equal(typeof content.text, "string");
});

// ---------- R2 ----------

test("R2: node rows carry the node type, whether it changed since the baseline and its confirmation lists; the text is as before", async (t) => {
  const f = graphProject(t, { confirm: true });
  const node = async (id) => answer(await read(QUERY, { project_root: f.root, question: "node", id })).rows.find((row) => row.depth === 0);
  const changed = await node(SAVE_CODE);
  assert.deepEqual([changed.nodeType, changed.changedSinceBaseline, changed.confirmation], ["코드", "changed", undefined]);
  const checked = await node(SAVE);
  // Its 뜻 line was checked and the code moved since; the document row that names it was never checked.
  assert.deepEqual([checked.nodeType, checked.changedSinceBaseline, checked.confirmation], ["기능", "reachChanged", ["neverChecked", "changedSinceCheck"]]);
  const never = await node("cli:sample-station");
  assert.deepEqual(never.confirmation, ["neverChecked"]);
  const overview = answer(await read(QUERY, { project_root: f.root, question: "find", text: "main_window" }));
  const unchanged = overview.rows.find((row) => row.kind === "node" && row.changedSinceBaseline === "unchanged");
  assert.ok(unchanged, "an unchanged node says so");
  // Starts (@…) and text rows carry none.
  const starts = answer(await read(QUERY, { project_root: f.root, question: "overview" })).rows.filter((row) => row.kind === "node");
  assert.ok(starts.length && starts.every((row) => row.id.startsWith("@") && row.nodeType === undefined));
  // The first build is compared with itself: unchanged. A build without a
  // comparison (no changes block, as an earlier version wrote) has no field.
  const fresh = fixture(t);
  fs.cpSync(path.join(fixtures, "ui-signal"), fresh.root, { recursive: true });
  buildProductGraph({ root: fresh.root });
  const first = answer(await read(QUERY, { project_root: fresh.root, question: "node", id: SAVE_CODE })).rows[0];
  assert.deepEqual([first.nodeType, first.changedSinceBaseline], ["코드", "unchanged"]);
  const checkFile = path.join(fresh.root, ".lode", "context", "product-graph", "build", "check.json");
  const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
  delete check.changes;
  fs.writeFileSync(checkFile, `${JSON.stringify(check, null, 2)}\n`);
  const plain = answer(await read(QUERY, { project_root: fresh.root, question: "node", id: SAVE_CODE })).rows[0];
  assert.equal(plain.nodeType, "코드");
  assert.equal(Object.hasOwn(plain, "changedSinceBaseline"), false);
  // The text of the row is the line the page shows, without the new fields in it.
  assert.ok(!changed.text.includes("changedSinceBaseline"));
});

// ---------- R3 ----------

test("R3: resultShape is returned for the main read tools by exact name and matches real answers", async (t) => {
  const f = graphProject(t);
  const shapes = {};
  for (const name of RESULT_SHAPE_TOOLS) {
    const found = answer(await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_discover", arguments: { name } } }));
    shapes[name] = found.tools[0].resultShape;
    assert.deepEqual(shapes[name], resultShapeFor(name), name);
  }
  const prefix = answer(
    await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_tools_discover", arguments: { prefix: "lode_project_" } } }),
  );
  assert.ok(
    prefix.tools.every((tool) => tool.resultShape === undefined),
    "only by exact name",
  );
  const at = (value, dotted) => dotted.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
  // Product graph: rows, fields, paging and build fields.
  const query = shapes[QUERY];
  const paged = answer(await read(QUERY, { project_root: f.root, question: "changes", list: "neverChecked", limit: 2 }));
  assert.ok(Array.isArray(at(paged, query.rows)));
  for (const row of paged.rows) for (const field of query.rowFields.always) assert.ok(Object.hasOwn(row, field), field);
  for (const dotted of Object.values(query.paging)) assert.notEqual(at(paged, dotted), undefined, dotted);
  for (const dotted of Object.values(query.build)) assert.notEqual(at(paged, dotted), undefined, dotted);
  const known = new Set([...query.rowFields.always, ...query.rowFields.nodeRows, ...query.rowFields.sometimes]);
  for (const args of [{ question: "overview" }, { question: "find", text: "save" }, { question: "up", id: SAVE }, { question: "changes", list: "changed" }]) {
    const value = answer(await read(QUERY, { project_root: f.root, ...args }));
    for (const row of value.rows) {
      for (const field of Object.keys(row)) assert.ok(known.has(field), `${field} of ${JSON.stringify(args)}`);
      assert.ok(query.rowKinds.includes(row.kind));
      if (row.kind === "node" && !row.id.startsWith("@")) assert.ok(query.rowFields.nodeRows.slice(0, 2).every((field) => Object.hasOwn(row, field)));
      if (row.changedSinceBaseline) assert.ok(query.fieldValues.changedSinceBaseline.includes(row.changedSinceBaseline));
      for (const key of row.confirmation || []) assert.ok(query.fieldValues.confirmation.includes(key));
    }
  }
  // Project graph and Session work.
  const graph = answer(await read("lode_project_graph", { project_root: f.root }));
  const graphShape = shapes.lode_project_graph;
  assert.ok(at(graph, graphShape.rows).length > 0);
  for (const row of at(graph, graphShape.rows)) for (const field of graphShape.rowFields.always) assert.ok(Object.hasOwn(row, field), field);
  for (const row of at(graph, graphShape.otherLists.edges)) for (const field of graphShape.rowFields.edges) assert.ok(Object.hasOwn(row, field), field);
  for (const dotted of Object.values(graphShape.paging)) assert.notEqual(at(graph, dotted), undefined, dotted);
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
  // A chain reads those lists with take.
  const taken = answer(
    await chain({
      project_root: f.root,
      steps: [
        { id: "w", read: { name: "lode_session_work_read", arguments: {} }, take: workShape.rows },
        { id: "s", from: "w", pick: ["content.summary"] },
      ],
      return: [{ from: "s" }],
    }),
  );
  assert.deepEqual(taken.results.s.rows, [{ "content.summary": "s" }]);
  assert.deepEqual(taken.basis, [{ tool: "lode_session_work_read", pinned: false }]);
});

test("bounds are one table: the reference quotes READ_CHAIN_LIMITS", () => {
  assert.deepEqual(READ_CHAIN_REFERENCE.bounds, {
    steps: READ_CHAIN_LIMITS.steps,
    innerCallsIncludingPages: READ_CHAIN_LIMITS.calls,
    callsOfOneEach: READ_CHAIN_LIMITS.eachCalls,
    pagesOfOneRead: READ_CHAIN_LIMITS.pages,
    returnedBytes: { default: 16 * 1024, max: 64 * 1024 },
    intermediateBytes: 16 * 1024 * 1024,
    inputBytes: READ_CHAIN_LIMITS.inputBytes,
  });
  assert.deepEqual([READ_CHAIN_LIMITS.steps, READ_CHAIN_LIMITS.calls, READ_CHAIN_LIMITS.eachCalls], [12, 40, 20]);
});

test("T5.2: a chain needs the caller's Session binding exactly when one of its inner calls would need it on its own", async () => {
  const { callRequiresBinding } = await import("../scripts/lib/session/session-native-host.mjs");
  const { sessionCallRequiresBinding } = await import("../scripts/lib/session/session-routing.mjs");
  const chainOf = (...reads) => ({ project_root: "P", steps: reads.map((read, index) => ({ id: `s${index}`, read })), return: [{ from: "s0" }] });
  assert.equal(sessionCallRequiresBinding("lode_project_status"), true);
  assert.equal(sessionCallRequiresBinding(QUERY), false);
  assert.equal(callRequiresBinding("lode_tools_read_chain", chainOf({ name: QUERY, arguments: {} })), false);
  assert.equal(callRequiresBinding("lode_tools_read_chain", chainOf({ name: QUERY, arguments: {} }, { name: "lode_project_status", arguments: {} })), true);
  assert.equal(callRequiresBinding("lode_tools_read_chain", chainOf({ name: "lode_project_graph", arguments: { session_id: "session-x" } })), true);
  // A grouped inner call is judged by the member operation its action selects.
  assert.equal(callRequiresBinding("lode_tools_read_chain", chainOf({ name: "lode_product_graph", arguments: { action: "query" } })), false);
  assert.equal(callRequiresBinding("lode_project_status", {}), true);
  assert.equal(callRequiresBinding("lode_tools_read_chain", { steps: "not a list" }), false);
});
