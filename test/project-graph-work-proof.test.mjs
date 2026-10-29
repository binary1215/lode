import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createHeadSession, withSessionRoute, sessionStatePath } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext, normalizeSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { localContinuityCommand } from "./helpers/session-continuity-process.mjs";
import { queryProjectGraph, indexProjectGraph } from "../scripts/lib/project-graph.mjs";
import { collectProjectGraphInventory } from "../scripts/lib/discovery-index.mjs";
import { createSessionWorkReadContext, MAX_RECORD_BYTES } from "../scripts/lib/session-work-evidence-original.mjs";
import { createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { fixture, exact, link, citation, snapshot, sha, encoded } from "./helpers/session-work-linkage-fixture.mjs";
import { formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";

// Public local writers/readers and synthetic faults only. No subprocess,
// installed Host, provider, model or actual execution evidence.
const relative = (f, file) => path.relative(f.root, file).replaceAll("\\", "/");

const inventoryArgs = args => ({ root: args.project_root, query: args.query, view: args.view,
  anchorIds: args.anchor_ids, paths: args.paths, depth: args.depth, maxNodes: args.max_nodes, maxEdges: args.max_edges,
  details: args.details, includeCandidates: args.include_candidates, worldModelId: args.world_model_id,
  inventoryPage: args.inventory_page, inventoryPaths: args.inventory_paths, inventoryCursor: args.inventory_cursor });
const inventoryEnvelope = result => Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: formatMcpToolContent("head_project_graph", result) }], structuredContent: result }));
function inventoryBounds(result) {
  const p = result.inventoryPage, c = p.counters, l = p.limits;
  assert.equal(result.plane, "P4-derived-view"); assert.equal(result.recoveryAuthority, false); assert.equal(result.executionAuthority, false);
  assert.deepEqual(result.nodes, []); assert.deepEqual(result.edges, []);
  assert(c.metadataEntries <= l.metadataEntries + l.metadataOverflowProbeEntries); assert(c.directoryOpens <= l.directoryOpens);
  assert(c.directoryReads <= l.directoryReads); assert.equal(c.directoryOpens, c.directoryCloses);
  assert(c.attemptedBytes <= l.attemptedBytes); assert(c.rows <= l.rows); assert.equal(c.rows, p.rows.length);
  assert(inventoryEnvelope(result) <= l.mcpEnvelopeUtf8Bytes);
  for (const row of p.rows) { assert.equal(row.typedValidity, "not-inspected"); assert.equal(row.kind, undefined); assert.equal(row.reviewState, undefined);
    if (row.byteObservation !== "inspected") assert.equal(row.digest, null); }
}

test("capacity-inventory: explicit continuation covers untyped originals once across CLI and direct/router MCP", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 540; i++) fs.writeFileSync(path.join(directory, `record-${String(i).padStart(4, "0")}.json`), i % 2 ? "{" : '{"kind":"ReviewDecision","disposition":"accepted","instruction":"untrusted"}');
  const before = snapshot(f.base), opened = [], open = fs.openSync, readDir = fs.readdirSync;
  fs.openSync = (file, ...args) => { if (String(file).startsWith(directory)) opened.push(String(file)); return open(file, ...args); };
  fs.readdirSync = () => { throw new Error("Inventory must stream bounded metadata rather than materialize readdir"); };
  let first, rows = [], next, pages = 0;
  try {
    first = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"], query: "No lexical overlap required" });
    let result = first;
    do {
      inventoryBounds(result); pages++; rows.push(...result.inventoryPage.rows); next = result.inventoryPage.next;
      if (!next) { assert.equal(result.inventoryPage.coverage.exhaustedObservedRange, true); break; }
      assert(pages < 10); result = await queryProjectGraph(inventoryArgs(next.arguments));
    } while (true);
  } finally { fs.openSync = open; fs.readdirSync = readDir; }
  assert.equal(rows.length, 540); assert.equal(new Set(rows.map(row => row.path)).size, 540);
  assert.equal(opened.length, 540); assert.equal(new Set(opened).size, 540);
  assert(rows.every(row => row.byteObservation === "inspected" && row.exactRead.supported === false));
  assert(first.inventoryPage.next); assert.equal(first.inventoryPage.coverage.remainingCount, null);
  for (const routed of [false, true]) {
    const next = first.inventoryPage.next;
    const response = await dispatch({ jsonrpc: "2.0", id: "inventory-next", method: "tools/call", params: {
      name: routed ? "lode_tools_call" : next.tool, arguments: routed ? { name: next.tool, arguments: next.arguments } : next.arguments } });
    assert.equal(response.error, undefined); assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    const result = response.result.structuredContent; inventoryBounds(result);
    assert.equal(result.inventoryPage.rows[0].path, rows[first.inventoryPage.rows.length].path);
    assert(Buffer.byteLength(JSON.stringify(response.result)) <= first.inventoryPage.limits.mcpEnvelopeUtf8Bytes);
  }
  const nextArgs = first.inventoryPage.next.arguments;
  const cli = await localContinuityCommand([path.join(path.resolve(import.meta.dirname, ".."), "scripts/lode.mjs"), "graph-query", f.root,
    "--inventory-page", "--inventory-paths", nextArgs.inventory_paths.join(","), "--inventory-cursor", nextArgs.inventory_cursor,
    "--query", nextArgs.query, "--json"], { cwd: path.resolve(import.meta.dirname, "..") });
  assert.equal(cli.code, 0, cli.stderr); const cliResult = JSON.parse(cli.stdout); inventoryBounds(cliResult);
  assert.equal(cliResult.inventoryPage.rows[0].path, rows[first.inventoryPage.rows.length].path);
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic(JSON.stringify({ pages, originals: rows.length, uniqueBodyOpens: new Set(opened).size, firstEnvelopeBytes: inventoryEnvelope(first), actualHost: false }));
});

test("capacity-inventory: actual 10001-entry flat directory stops metadata and offers observed exact scopes", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(directory, `${String(i).padStart(5, "0")}.json`), "{}");
  const result = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] });
  inventoryBounds(result); const p = result.inventoryPage;
  assert.equal(p.coverage.status, "metadata-bound"); assert.equal(p.counters.metadataEntries, 10001); assert.equal(p.counters.attemptedBodies, 0);
  assert.equal(p.next, null); assert.equal(p.coverage.exhaustedObservedRange, false); assert.equal(p.coverage.remainingCount, null);
  assert(p.narrowing.length > 0);
  const narrowed = await queryProjectGraph(inventoryArgs(p.narrowing[0].arguments)); inventoryBounds(narrowed);
  assert.equal(narrowed.inventoryPage.rows.length, 1); assert.equal(narrowed.inventoryPage.rows[0].byteObservation, "inspected");
});

test("capacity-inventory: byte frontier, oversize and short-read failures advance without partial digests", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  const full = Buffer.alloc(16 * 1024 * 1024, 32);
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(directory, `large-${i}.json`), full);
  const first = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); inventoryBounds(first);
  assert.equal(first.inventoryPage.counters.attemptedBytes, 128 * 1024 * 1024); assert.equal(first.inventoryPage.rows.length, 8); assert(first.inventoryPage.next);
  const second = await queryProjectGraph(inventoryArgs(first.inventoryPage.next.arguments)); inventoryBounds(second);
  assert.equal(second.inventoryPage.rows.length, 1); assert.equal(second.inventoryPage.rows[0].path.endsWith("large-8.json"), true);
  const tooLarge = path.join(directory, "oversize.json"); fs.writeFileSync(tooLarge, Buffer.alloc(16 * 1024 * 1024 + 1));
  const oversize = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [relative(f, tooLarge)] }); inventoryBounds(oversize);
  assert.equal(oversize.inventoryPage.rows[0].reasonCode, "PROJECT_GRAPH_INVENTORY_FILE_BOUND"); assert.equal(oversize.inventoryPage.counters.attemptedBodies, 0);
  const read = fs.readSync, open = fs.openSync, close = fs.closeSync, faultFds = new Set(); let reads = 0;
  fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (String(file).startsWith(directory)) faultFds.add(fd); return fd; };
  fs.closeSync = fd => { faultFds.delete(fd); return close(fd); };
  fs.readSync = (fd, buffer, offset, length, position) => { if (!faultFds.has(fd)) return read(fd, buffer, offset, length, position);
    if (reads++ === 0) return read(fd, buffer, offset, Math.min(length, 12), position); throw Object.assign(new Error("synthetic read failure"), { code: "EIO" }); };
  let partial;
  try { partial = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations/large-0.json"] }); }
  finally { fs.readSync = read; fs.openSync = open; fs.closeSync = close; }
  inventoryBounds(partial); assert.equal(partial.inventoryPage.rows[0].digest, null); assert.equal(partial.inventoryPage.rows[0].inspectedBytes, 12);
  assert.equal(partial.inventoryPage.coverage.exhaustedObservedRange, true);
});

test("capacity-inventory: cursor owner/query/scope/path validation and changed frontier remain local", async t => {
  const f = fixture(t), g = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(directory, `${String(i).padStart(4, "0")}.json`), "{}");
  const first = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); const args = inventoryArgs(first.inventoryPage.next.arguments);
  for (const change of [{ root: g.root }, { query: "different" }, { inventoryPaths: [".lode/lineage"] }, { worldModelId: "different" }, { inventoryCursor: "x".repeat(4097) }])
    await assert.rejects(((queryProjectGraph({ ...args, ...change }))), /INVALID_PROJECT_GRAPH_INVENTORY_CURSOR/);
  const bad = JSON.parse(Buffer.from(args.inventoryCursor, "base64url")); bad.frontier.path = ".lode/observations/../../project.json";
  await assert.rejects(((queryProjectGraph({ ...args, inventoryCursor: Buffer.from(JSON.stringify(bad)).toString("base64url") }))), /INVALID_PROJECT_GRAPH_INVENTORY_CURSOR/);
  for (const invalid of ["../escape", ".head/observations", ".lode/host-private", ".lode/observations/../project.json", ".lode/observations:C"]) {
    await assert.rejects(((queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [invalid] }))), /INVALID_PROJECT_GRAPH_INVENTORY_SCOPE/);
  }
  const removed = path.join(f.root, ...first.inventoryPage.coverage.examinedThrough.path.split("/")); fs.unlinkSync(removed);
  const before = snapshot(f.base), changed = await queryProjectGraph(args); inventoryBounds(changed);
  assert.equal(changed.inventoryPage.coverage.status, "changed-scope"); assert.equal(changed.inventoryPage.next, null);
  assert.equal(changed.inventoryPage.counters.attemptedBodies, 0); assert.deepEqual(snapshot(f.base), before);
});

test("capacity-inventory: nested ordering, empty/non-JSON metadata and unsupported entries never become nodes", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(path.join(directory, "a"), { recursive: true });
  fs.writeFileSync(path.join(directory, "a.json"), "{"); fs.writeFileSync(path.join(directory, "a", "a.json"), "{}");
  fs.writeFileSync(path.join(directory, "b.json"), "{}");
  for (let i = 0; i < 40; i++) { fs.mkdirSync(path.join(directory, `empty-${i}`)); fs.writeFileSync(path.join(directory, `note-${i}.txt`), "not a record"); }
  let result = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations/a/a.json", ".lode/observations"] });
  const rows = [];
  for (let i = 0; i < 10; i++) {
    inventoryBounds(result); rows.push(...result.inventoryPage.rows);
    if (!result.inventoryPage.next) { assert.equal(result.inventoryPage.coverage.exhaustedObservedRange, true); break; }
    result = await queryProjectGraph(inventoryArgs(result.inventoryPage.next.arguments));
  }
  assert.deepEqual(rows.map(row => row.path).sort(), [".lode/observations/a.json", ".lode/observations/a/a.json", ".lode/observations/b.json"].sort());
  const empty = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations/empty-0"] }); inventoryBounds(empty);
  assert.equal(empty.inventoryPage.counters.directoryReads, 1); assert.equal(empty.inventoryPage.rows.length, 0);
  const saved = f.save({ summary: "Synthetic exact read" });
  const typedPage = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [relative(f, saved.file)] });
  const nextRead = typedPage.inventoryPage.rows[0].exactRead; assert.equal(nextRead.supported, true);
  const actual = await dispatch({ jsonrpc: "2.0", id: "inventory-exact", method: "tools/call", params: { name: nextRead.tool, arguments: nextRead.arguments } });
  assert.equal(actual.result?.isError, undefined, JSON.stringify(actual)); assert(actual.result.structuredContent.nodes.some(row => row.nodeId === saved.evidence.evidenceId));
});

test("capacity-inventory: all failed bodies still terminate with bounded full-envelope diagnostics", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 530; i++) fs.writeFileSync(path.join(directory, `한글-😀-${String(i).padStart(4, "0")}.json`), "{}");
  const read = fs.readSync, open = fs.openSync, close = fs.closeSync, faultFds = new Set();
  fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (String(file).startsWith(directory)) faultFds.add(fd); return fd; };
  fs.closeSync = fd => { faultFds.delete(fd); return close(fd); };
  fs.readSync = (fd, ...args) => { if (!faultFds.has(fd)) return read(fd, ...args); throw Object.assign(new Error("synthetic error must not escape"), { code: "EIO" }); };
  const paths = []; let result;
  try {
    result = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] });
    for (let i = 0; i < 10; i++) {
      inventoryBounds(result); assert.equal(result.inventoryPage.counters.failures, result.inventoryPage.rows.length);
      paths.push(...result.inventoryPage.rows.map(row => row.path));
      if (!result.inventoryPage.next) { assert.equal(result.inventoryPage.coverage.exhaustedObservedRange, true); break; }
      result = await queryProjectGraph(inventoryArgs(result.inventoryPage.next.arguments));
    }
  } finally { fs.readSync = read; fs.openSync = open; fs.closeSync = close; }
  assert.equal(paths.length, 530); assert.equal(new Set(paths).size, 530);
});

test("capacity-inventory: streamed metadata failures, depth and junctions are local without leaking foreign bytes", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(directory, { recursive: true });
  const foreign = path.join(f.base, "foreign"); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "secret.json"), "foreign bytes never read");
  fs.symlinkSync(foreign, path.join(directory, "junction"), process.platform === "win32" ? "junction" : "dir");
  const open = fs.openSync; let foreignReads = 0;
  fs.openSync = (file, ...args) => { if (String(file).includes("secret.json")) foreignReads++; return open(file, ...args); };
  let result;
  try { result = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); }
  finally { fs.openSync = open; }
  inventoryBounds(result); assert.equal(foreignReads, 0); assert.equal(result.inventoryPage.rows[0].reasonCode, "PROJECT_GRAPH_SYMLINK_PATH");
  const denied = fs.opendirSync;
  fs.opendirSync = (...args) => { if (String(args[0]) === directory) throw Object.assign(new Error("private path must not become error text"), { code: "EACCES" }); return denied(...args); };
  let failure;
  try { failure = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); }
  finally { fs.opendirSync = denied; }
  inventoryBounds(failure); assert.equal(failure.inventoryPage.rows[0].reasonCode, "EACCES"); assert.equal(failure.inventoryPage.counters.directoryOpenAttempts, 1);
  assert.equal(failure.inventoryPage.coverage.uninspectedSubtreeCount, 1); assert.equal(failure.inventoryPage.rows[0].subtreeMembership, "not-inspected");
  assert(!JSON.stringify(failure).includes("private path must not"));
  if (process.platform === "win32") fs.rmdirSync(path.join(directory, "junction")); else fs.unlinkSync(path.join(directory, "junction"));
  const unwitnessed = path.join(directory, "unwitnessed.json"); fs.writeFileSync(unwitnessed, "{}");
  const lstat = fs.lstatSync;
  fs.lstatSync = (file, ...args) => { if (String(file) === unwitnessed) throw Object.assign(new Error("synthetic metadata denied"), { code: "EACCES" }); return lstat(file, ...args); };
  let unknown;
  try { unknown = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); }
  finally { fs.lstatSync = lstat; }
  inventoryBounds(unknown); assert.equal(unknown.inventoryPage.coverage.status, "changed-scope"); assert.equal(unknown.inventoryPage.next, null);
  assert.equal(unknown.inventoryPage.rows[0].reasonCode, "EACCES"); fs.unlinkSync(unwitnessed);
  const deep = Array.from({ length: 11 }, (_, i) => `nested-${i}`).join("/"); fs.mkdirSync(path.join(directory, deep), { recursive: true });
  fs.writeFileSync(path.join(directory, deep, "end.json"), "{}");
  const depth = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: [".lode/observations"] }); inventoryBounds(depth);
  assert.equal(depth.inventoryPage.coverage.status, "metadata-bound"); assert.equal(depth.inventoryPage.next, null); assert(depth.inventoryPage.narrowing[0]);
  const narrower = await queryProjectGraph(inventoryArgs(depth.inventoryPage.narrowing[0].arguments)); inventoryBounds(narrower);
  assert.equal(narrower.inventoryPage.rows.length, 1); assert.equal(narrower.inventoryPage.rows[0].byteObservation, "inspected");
});

test("capacity-inventory: canonical lineage and retained direction return callable existing typed readers", async t => {
  const f = fixture(t), plan = f.route(() => createWholePlanSnapshot({ root: f.root, objective: "Synthetic page expansion", plan: "Read only" }));
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Synthetic historical direction" } }).direction;
  const scopes = [relative(f, plan.file), `.lode/project-direction/revisions/${direction.directionId}.json`];
  const before = snapshot(f.base), result = await queryProjectGraph({ root: f.root, inventoryPage: true, inventoryPaths: scopes }); inventoryBounds(result);
  assert.equal(result.inventoryPage.rows.length, 2);
  for (const row of result.inventoryPage.rows) for (const routed of [false, true]) {
    const hint = row.exactRead;
    const response = await dispatch({ jsonrpc: "2.0", id: "inventory-typed", method: "tools/call", params: {
      name: routed ? "lode_tools_call" : hint.tool, arguments: routed ? { name: hint.tool, arguments: hint.arguments } : hint.arguments } });
    assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    if (row.path.includes("lineage")) assert.equal(response.result.structuredContent.artifact.wholePlanId, plan.artifact.wholePlanId);
    else assert.equal(response.result.structuredContent.nodes[0].nodeId, direction.directionId);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("capacity-inventory: human CLI and direct/router MCP escape controls while original next arguments roundtrip", async t => {
  const f = fixture(t), directory = path.join(f.root, ".lode/observations"); fs.mkdirSync(path.join(directory, "z"), { recursive: true });
  fs.writeFileSync(path.join(directory, "a.json"), "{}"); fs.writeFileSync(path.join(directory, "z", "x.json"), "{}");
  const query = "Before \u009b\u009d\u009c\u2028\u202e after", args = { project_root: f.root, inventory_page: true, inventory_paths: [".lode/observations"], query };
  const result = await queryProjectGraph(inventoryArgs(args)); inventoryBounds(result); assert(result.inventoryPage.next);
  assert.equal(result.inventoryPage.next.arguments.query, query);
  const unsafe = /[\u0080-\u009f\u2028-\u202e]/u;
  const text = formatMcpToolContent("lode_project_graph", result); assert.equal(unsafe.test(text), false);
  assert.deepEqual(JSON.parse(text.split("\n").find(line => line.startsWith("Next: ")).slice(6)), result.inventoryPage.next);
  // Presentation-only counterexamples for all JSON/detail/diagnostic positions;
  // these injected display fragments are not verified originals or tool calls.
  const display = structuredClone(result), p = display.inventoryPage;
  p.rows[0].path += "\u009b"; p.rows[0].reasonCode = "\u009d";
  p.rows[0].exactRead = { supported: true, tool: "lode_project_graph", arguments: { query } };
  p.narrowing = [p.next]; p.warnings = [{ path: query, reasonCode: query }];
  const rendered = formatMcpToolContent("lode_project_graph", display); assert.equal(unsafe.test(rendered), false);
  assert.deepEqual(JSON.parse(rendered.split("\n").find(line => line.startsWith("Read: ")).slice(6)), p.rows[0].exactRead);
  assert.deepEqual(JSON.parse(rendered.split("\n").find(line => line.startsWith("Narrow scope: ")).slice(14)), p.narrowing);
  for (const routed of [false, true]) {
    const response = await dispatch({ jsonrpc: "2.0", id: "inventory-control", method: "tools/call", params: {
      name: routed ? "lode_tools_call" : "lode_project_graph", arguments: routed ? { name: "lode_project_graph", arguments: args } : args } });
    assert.equal(response.error, undefined); assert.equal(unsafe.test(response.result.content[0].text), false);
    assert.equal(response.result.structuredContent.inventoryPage.next.arguments.query, query);
    inventoryBounds(response.result.structuredContent);
  }
  const cli = await localContinuityCommand([path.join(path.resolve(import.meta.dirname, ".."), "scripts/lode.mjs"), "graph-query", f.root,
    "--inventory-page", "--inventory-paths", ".lode/observations", "--query", query], { cwd: path.resolve(import.meta.dirname, "..") });
  assert.equal(cli.code, 0, cli.stderr); assert.equal(unsafe.test(cli.stdout), false);
  const next = JSON.parse(cli.stdout.split(/\r?\n/).find(line => line.startsWith("Next: ")).slice(6)); assert.equal(next.arguments.query, query);
  const continued = await queryProjectGraph(inventoryArgs(next.arguments)); assert.equal(continued.inventoryPage.rows[0].path, ".lode/observations/z/x.json");
});

test("capacity-stage2: exact lineage retains managed reader dependencies and callable original expansion", async t => {
  const f = fixture(t), work = f.save({ summary: "Independent intact work" });
  const plan = f.route(() => createWholePlanSnapshot({ root: f.root, objective: "Retained narrow plan", plan: "No current authorization" }));
  const manifestPath = path.join(f.root, ".lode/generated/manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const selectedState = f.route(() => sessionStatePath(f.root, f.layout)), reads = new Map();
  const read = fs.readFileSync, readdir = fs.readdirSync;
  const key = file => path.resolve(String(file)).replaceAll("\\", "/").toLowerCase();
  fs.readFileSync = (file, ...args) => { const value = read(file, ...args); if (typeof file !== "number") {
    const name = key(file), previous = reads.get(name) || { count: 0, bytes: 0 };
    reads.set(name, { count: previous.count + 1, bytes: previous.bytes + (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength) });
  } return value; };
  fs.readdirSync = file => { throw new Error("Exact lineage must not enumerate unrelated inventory: " + file); };
  let result;
  try { result = await f.route(async () => (await queryProjectGraph({ root: f.root, paths: [relative(f, plan.file)], details: false }))); }
  finally { fs.readFileSync = read; fs.readdirSync = readdir; }
  const node = result.nodes.find(row => row.nodeId === plan.artifact.wholePlanId); assert(node); noAuthority(result);
  assert(reads.has(key(manifestPath))); assert(reads.has(key(selectedState)));
  for (const managed of manifest.managed) assert(reads.has(key(path.join(f.root, managed.path))));
  assert.match(result.coverage.inventoryScope.lineageReadDependencies, /not a single-file cost bound/);
  assert.deepEqual(node.detail.paths, [relative(f, plan.file)]);
  const response = await dispatch({ jsonrpc: "2.0", id: "stage2-exact-lineage", method: "tools/call", params: {
    name: node.originalExpansion.tool, arguments: { ...node.originalExpansion.arguments, session_id: f.session.sessionId } } });
  assert.equal(response.error, undefined); assert.equal(response.result?.isError, undefined);
  assert.equal(response.result.structuredContent.artifact.wholePlanId, plan.artifact.wholePlanId);
  fs.writeFileSync(manifestPath, "{"); const before = snapshot(f.base);
  const unavailable = await f.route(async () => (await queryProjectGraph({ root: f.root, paths: [relative(f, plan.file)] })));
  assert.equal(unavailable.nodes.some(row => row.nodeId === plan.artifact.wholePlanId), false);
  assert(unavailable.integrity.excluded.some(row => row.layer === "lineage"));
  assertWork(await queryProjectGraph({ ...q(f, work), paths: [relative(f, work.file)] }), work);
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic(JSON.stringify({ scope: "Existing lineage exact reader dependency observations, not one-file or current-authorization proof",
    sessionReads: reads.get(key(selectedState)), manifestReads: reads.get(key(manifestPath)), managedFileCount: manifest.managed.length }));
});

test("capacity-stage2: historical direction detail does not inspect a missing current pointer's whole trace", async t => {
  const f = fixture(t), old = updateProjectDirection({ root: f.root, input: { goal: "Earlier retained goal", cancelledActions: ["deploy"] } }).direction;
  updateProjectDirection({ root: f.root, expectedDirectionId: old.directionId, input: { goal: "Later goal", cancelledActions: ["deploy", "publish"] } });
  fs.unlinkSync(path.join(f.root, ".lode/project-direction/current.json"));
  const relativePath = `.lode/project-direction/revisions/${old.directionId}.json`, before = snapshot(f.base);
  const readdir = fs.readdirSync; let enumerations = 0;
  fs.readdirSync = file => { enumerations++; throw new Error("Historical revision must not enumerate currentness traces: " + file); };
  let result, expanded;
  try {
    result = await queryProjectGraph({ root: f.root, paths: [relativePath], anchorIds: [old.directionId], details: false });
    expanded = await queryProjectGraph({ root: f.root, ...result.nodes[0].detail });
  } finally { fs.readdirSync = readdir; }
  assert.equal(enumerations, 0); assert.equal(result.nodes[0].nodeId, old.directionId); noAuthority(result); noAuthority(expanded);
  assert.equal(result.nodes[0].freshness, "retained-direction-reference-currentness-unknown");
  assert.equal(result.coverage.inventoryScope.directionCurrentness, "not-inspected");
  assert.deepEqual(result.nodes[0].detail.paths, [relativePath]);
  assert.equal(expanded.nodes[0].directionEvidence.goal, old.input.goal);
  assert.equal(result.nodes[0].originalExpansion.supported, false);
  assert(!JSON.stringify(result.nodes[0].originalExpansion).includes("lode_project_direction_read"));
  assert.deepEqual(snapshot(f.base), before);
});

test("capacity: cold exact work paths precede the actual 10000-record inventory and work in CLI and routed MCP", async t => {
  const f = fixture(t), root = f.save({ summary: "Exact root retained" });
  const saved = f.save({ summary: "한글 exact reason 😀", workLink: link(root), pending: ["Inspect only"] });
  const padding = path.join(f.root, ".lode/observations"); fs.mkdirSync(padding, { recursive: true });
  // Deliberate untyped inventory noise: not claimed to be valid observations.
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(padding, `inventory-${String(i).padStart(5, "0")}.json`), "{}");
  const bounded = collectProjectGraphInventory(f.root);
  assert.equal(bounded.entries.length, 10000); assert.equal(bounded.complete, false);
  assert.equal(bounded.entries.some(entry => entry.path === relative(f, saved.file)), false);
  const before = snapshot(f.base), readdir = fs.readdirSync; let inventoryReads = 0;
  fs.readdirSync = (file, ...args) => { inventoryReads++; throw new Error("Exact work must not enumerate global membership: " + file); };
  let exactResult, compact;
  try {
    exactResult = await queryProjectGraph({ ...q(f, saved), paths: [relative(f, saved.file)], depth: 1, maxNodes: 5, maxEdges: 5 });
    assertWork(exactResult, saved); assertWork(exactResult, root);
    compact = await queryProjectGraph({ ...q(f, saved), paths: [relative(f, saved.file)], details: false });
    const expanded = await queryProjectGraph({ root: f.root, ...nodeFor(compact, saved).detail });
    assertWork(expanded, saved);
  } finally { fs.readdirSync = readdir; }
  assert.equal(inventoryReads, 0);
  assert.equal(exactResult.coverage.inventoryScope.unrelatedMembership, "not-inspected");
  assert.equal(exactResult.coverage.inventoryScope.incomingRelationsOutsideScope, "unknown");
  assert.equal(exactResult.coverage.inventoryBoundReached, false);
  assert.equal(exactResult.coverage.emptyResultProvesAbsence, false);
  assert.equal(exactResult.sourceFallback.needed, false, "Uninspected unrelated Product/World is not an obligation to read again");
  const cli = await localContinuityCommand([path.join(path.resolve(import.meta.dirname, ".."), "scripts/lode.mjs"), "graph-query", f.root,
    "--paths", relative(f, saved.file), "--details", "--json"], { cwd: path.resolve(import.meta.dirname, "..") });
  assert.equal(cli.code, 0, cli.stderr); assertWork(JSON.parse(cli.stdout), saved);
  for (const routed of [false, true]) {
    const args = { project_root: f.root, paths: [relative(f, saved.file)], details: true };
    const response = await dispatch({ jsonrpc: "2.0", id: "capacity-exact", method: "tools/call", params: {
      name: routed ? "head_tools_call" : "head_project_graph", arguments: routed ? { name: "head_project_graph", arguments: args } : args } });
    assert.equal(response.error, undefined); assert.equal(response.result?.isError, undefined);
    assertWork(response.result.structuredContent, saved); assert(response.result.content[0].text.includes("한글 exact reason"));
  }
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Actual default collector boundary and public CLI/MCP; synthetic files, no real large repository or Host/model proof");
});

test("capacity: exact work paths reverify owner and tampered bytes without disabling valid exact reads", async t => {
  const f = fixture(t), saved = f.save({ summary: "Retained exact text" });
  assertWork(await queryProjectGraph({ ...q(f, saved), paths: [relative(f, saved.file)] }), saved);
  const original = fs.readFileSync(saved.file); replaceSameMetadata(saved.file, "Retained", "Changed ");
  const before = snapshot(f.base), bad = await queryProjectGraph({ ...q(f, saved), paths: [relative(f, saved.file)] });
  assert.equal(nodeFor(bad, saved), undefined); assert(bad.integrity.excluded.length); assert.deepEqual(snapshot(f.base), before);
  fs.writeFileSync(saved.file, original);
  const other = createHeadSession({ root: f.root, purpose: "Different owner" });
  const wrong = path.join(path.dirname(withSessionRoute(f.root, other.sessionId, () => sessionStatePath(f.root, f.layout))), "work-evidence", path.basename(saved.file));
  fs.mkdirSync(path.dirname(wrong), { recursive: true }); fs.writeFileSync(wrong, original);
  const foreign = await queryProjectGraph({ ...q(f, saved), paths: [relative(f, wrong)] });
  assert.equal(nodeFor(foreign, saved), undefined); assert(foreign.integrity.excluded.length);
  assertWork(await queryProjectGraph({ ...q(f, saved), paths: [relative(f, saved.file)] }), saved);
  assert.equal(f.route(() => readSessionWorkContext({ root: f.root, evidenceIds: [saved.evidence.evidenceId] })).records[0].evidenceId, saved.evidence.evidenceId);
});

test("capacity: first lexical page returns actual continuation without a fabricated ID or repeated prefix bodies", async t => {
  const f = fixture(t), seed = f.save({ summary: "Synthetic page seed" }), directory = path.dirname(seed.file);
  // Build inert canonical fixture originals from one public writer template;
  // this tests readers, not 513 independent writer/index publication operations.
  for (let i = 0; i < 512; i++) {
    const content = normalizeSessionWorkEvidence({ summary: `페이지 😀 ${i}`, occurrenceKey: `capacity-${i}` });
    const evidenceId = "work-evidence-" + sha(encoded({ projectId: seed.evidence.projectId, sessionId: seed.evidence.sessionId, content })).slice(0, 24);
    const { evidenceDigest, ...base } = seed.evidence;
    const payload = { ...base, evidenceId, content }, record = { ...payload, evidenceDigest: sha(encoded(payload)) };
    fs.writeFileSync(path.join(directory, evidenceId + ".json"), JSON.stringify(record));
  }
  const names = fs.readdirSync(directory).sort(); fs.writeFileSync(path.join(directory, names[0]), "{");
  fs.truncateSync(path.join(directory, names[1]), MAX_RECORD_BYTES + 1);
  const before = snapshot(f.base), first = f.route(() => readSessionWorkContext({ root: f.root, scanEvidence: true }));
  assert(first.coverage.inspected > 0 && first.coverage.inspected <= 512); assert.equal(first.coverage.unavailable, 2);
  assert.equal(first.nextAfterEvidenceId + ".json", names[first.coverage.inspected - 1]);
  assert.equal(first.enumeration.next.arguments.after_evidence_id, first.nextAfterEvidenceId);
  assert.equal(first.enumeration.wholeHistoryComplete, false);
  const read = fs.readFileSync; let prefixBodyReads = 0;
  const prefix = new Set(names.slice(0, first.coverage.inspected).map(name => path.join(directory, name)));
  fs.readFileSync = (file, ...args) => { if (prefix.has(String(file))) prefixBodyReads++; return read(file, ...args); };
  let next; try { next = f.route(() => readSessionWorkContext({ root: f.root, scanEvidence: true, afterEvidenceId: first.nextAfterEvidenceId })); }
  finally { fs.readFileSync = read; }
  assert(next.coverage.inspected > 0); assert.equal(prefixBodyReads, 0);
  const reached = new Set([...first.records.map(row => row.evidenceId), ...first.omissions.evidenceIds, ...first.unavailable.map(row => row.evidenceId)]);
  let page = next, pageCount = 1;
  while (page) {
    for (const id of [...page.records.map(row => row.evidenceId), ...page.omissions.evidenceIds, ...page.unavailable.map(row => row.evidenceId)]) {
      assert(!reached.has(id)); reached.add(id);
    }
    const selector = page.enumeration.next;
    if (!selector) break;
    const currentRead = fs.readFileSync; let repeated = 0;
    fs.readFileSync = (file, ...args) => {
      if (String(file).startsWith(directory) && reached.has(path.basename(String(file)).slice(0, -5))) repeated++;
      return currentRead(file, ...args);
    };
    try { page = f.route(() => readSessionWorkContext({ root: f.root, scanEvidence: true, afterEvidenceId: selector.arguments.after_evidence_id })); }
    finally { fs.readFileSync = currentRead; }
    assert.equal(repeated, 0); assert(++pageCount <= names.length);
  }
  assert.equal(reached.size, names.length, "All 513 originals remain reachable through actual next arguments");
  const cli = await localContinuityCommand([path.join(path.resolve(import.meta.dirname, ".."), "scripts/lode.mjs"), "session-work-read", f.root,
    "--session", f.session.sessionId, "--scan-evidence", "--json"], { cwd: path.resolve(import.meta.dirname, "..") });
  assert.equal(cli.code, 0, cli.stderr || cli.stdout); assert.equal(JSON.parse(cli.stdout).nextAfterEvidenceId, first.nextAfterEvidenceId);
  for (const routed of [false, true]) {
    for (const args of [{ project_root: f.root, session_id: f.session.sessionId, scan_evidence: true }, first.enumeration.next.arguments]) {
      const response = await dispatch({ jsonrpc: "2.0", id: "capacity-page", method: "tools/call", params: {
        name: routed ? "head_tools_call" : "head_session_work_read", arguments: routed ? { name: "head_session_work_read", arguments: args } : args } });
      assert.equal(response.error, undefined); assert.equal(response.result?.isError, undefined);
      assert(response.result.content[0].text.includes("enumeration"));
      assert.equal(response.result.structuredContent.coverage.inspected, args.after_evidence_id ? next.coverage.inspected : first.coverage.inspected);
    }
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("capacity: exact path optimization preserves separate plan and work anchor priority", async t => {
  const f = fixture(t), work = f.save({ summary: "Path-selected original" }), other = f.save({ summary: "Explicit other original" });
  const plan = f.route(() => createWholePlanSnapshot({ root: f.root, objective: "Explicit plan anchor", plan: "Retained evidence only" })).artifact;
  const before = snapshot(f.base);
  for (const anchorId of [plan.wholePlanId, other.evidence.evidenceId]) {
    const result = await queryProjectGraph({ root: f.root, paths: [relative(f, work.file)], anchorIds: [anchorId], details: true, depth: 0 });
    assert.deepEqual(result.nodes.map(node => node.nodeId), [anchorId]);
    assert.equal(result.coverage.inventoryScope, undefined);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("capacity: tiny default and maximum delivery budgets leave no stranded original or prefix reread", t => {
  const f = fixture(t), seed = f.save({ summary: "Seed " + "x".repeat(50000) }), directory = path.dirname(seed.file);
  for (let i = 0; i < 60; i++) {
    const content = normalizeSessionWorkEvidence({ summary: `Large record ${i} ` + "x".repeat(50000), occurrenceKey: `capacity-large-${i}` });
    const evidenceId = "work-evidence-" + sha(encoded({ projectId: seed.evidence.projectId, sessionId: seed.evidence.sessionId, content })).slice(0, 24);
    const { evidenceDigest, ...base } = seed.evidence, payload = { ...base, evidenceId, content };
    fs.writeFileSync(path.join(directory, evidenceId + ".json"), JSON.stringify({ ...payload, evidenceDigest: sha(encoded(payload)) }));
  }
  const all = fs.readdirSync(directory).sort().map(name => name.slice(0, -5)), before = snapshot(f.base);
  for (const [maxRecords, maxCharacters] of [[8, 2], [8, 32768], [512, 524288]]) {
    const reached = new Set(); let afterEvidenceId = null, pages = 0;
    do {
      const read = fs.readFileSync; let repeated = 0;
      fs.readFileSync = (file, ...args) => {
        const name = path.basename(String(file));
        if (String(file).startsWith(directory) && reached.has(name.slice(0, -5))) repeated++;
        return read(file, ...args);
      };
      let page;
      try { page = f.route(() => readSessionWorkContext({ root: f.root, scanEvidence: true, afterEvidenceId, maxRecords, maxCharacters })); }
      finally { fs.readFileSync = read; }
      const disclosed = [...page.records.map(record => record.evidenceId), ...page.omissions.evidenceIds, ...page.unavailable.map(row => row.evidenceId)];
      assert.equal(new Set(disclosed).size, page.coverage.inspected, "Every examined original has a body or exact selector");
      assert.equal(page.omissions.omittedIdCount, 0); assert.equal(repeated, 0);
      assert(page.omissions.evidenceIds.length + page.unavailable.length <= 32);
      assert(page.coverage.usedCharacters <= maxCharacters);
      for (const id of disclosed) { assert(!reached.has(id)); reached.add(id); }
      const next = page.enumeration.next;
      if (next) {
        assert(next.arguments.after_evidence_id > (afterEvidenceId || ""));
        afterEvidenceId = next.arguments.after_evidence_id;
      } else afterEvidenceId = null;
      assert(++pages <= all.length, "No non-progressing cursor loop");
    } while (afterEvidenceId !== null);
    assert.deepEqual([...reached].sort(), all);
    t.diagnostic(JSON.stringify({ maxRecords, maxCharacters, reached: reached.size, pages }));
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("work read cache saturation does not reject an otherwise valid reference", t => {
  const f = fixture(t), originalRead = fs.readFileSync, shared = Buffer.alloc(16 * 1024 * 1024);
  const names = Array.from({ length: 9 }, (_, i) => `cache-reference-${i}.txt`);
  const targets = new Set(names.map(name => path.join(f.root, name)));
  const reads = new Map();
  for (const name of names) fs.writeFileSync(path.join(f.root, name), "stub");
  // Mock logical cache occupancy without writing/allocating nine large files.
  fs.readFileSync = function (file, ...args) {
    if (!targets.has(String(file))) return originalRead.call(this, file, ...args);
    const name = path.basename(String(file)); reads.set(name, (reads.get(name) || 0) + 1);
    return shared;
  };
  try {
    const context = createSessionWorkReadContext(f.root);
    for (const name of names) {
      const bytes = context.read(name, shared.length);
      assert(Buffer.isBuffer(bytes)); assert.equal(bytes.length, shared.length); assert(bytes.equals(shared));
      assert.notEqual(bytes, shared, "A public read must not expose retained source bytes");
      bytes[0] = 1; assert.equal(shared[0], 0, "Caller mutation must not change the observed source");
    }
    assert(context.read(names[0], shared.length).equals(shared), "Cached content survives caller mutation");
    assert(context.read(names.at(-1), shared.length).equals(shared), "A saturated cache still reads the valid reference");
    for (const name of names.slice(0, -1)) assert.equal(reads.get(name), 1, "Retained inputs reuse their observation");
    assert.equal(reads.get(names.at(-1)), 2, "An unretained input is read again, not rejected by cache capacity");
    assert.throws(() => context.read(names.at(-1), 65536), { code: "SESSION_WORK_REFERENCE_UNAVAILABLE" });
    assert(context.read(names.at(-1), shared.length).equals(shared), "A tighter read bound must not poison a later valid read");
    assert.equal(reads.get(names.at(-1)), 4);
  } finally { fs.readFileSync = originalRead; }
});
const indexFile = f => path.join(f.root, f.layout.directory, "graph-discovery/index.json");
const q = (f, saved, extra = {}) => ({ root: f.root, anchorIds: [saved.evidence.evidenceId], view: "work", details: true,
  depth: 0, maxNodes: 1, maxEdges: 0, ...extra });
const nodeFor = (result, saved) => result.nodes.find(node => node.nodeId === saved.evidence.evidenceId);
const edgeFor = (result, type, from, to) => result.edges.find(edge => edge.type === type
  && edge.from === from.evidence.evidenceId && edge.to === (to.evidence?.evidenceId || to.sessionId));
function noAuthority(result) {
  for (const value of [result.authority, ...result.nodes, ...result.edges]) {
    for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(value[field], false);
  }
  assert.equal(result.authority.ordinaryWorkBlocked, false);
}
function assertWork(result, saved) {
  const node = nodeFor(result, saved); assert.ok(node, "Missing exact work original " + saved.evidence.evidenceId);
  assert.equal(node.kind, "Evidence"); assert.equal(node.subtype, "SessionWorkEvidence");
  assert.equal(node.sessionId, saved.evidence.sessionId); assert.equal(node.evidenceDigest, saved.evidence.evidenceDigest);
  assert.deepEqual(node.workContent, saved.evidence.content);
  assert.equal(node.sourceReference.digest, sha(fs.readFileSync(saved.file)));
  noAuthority(result); return node;
}
function replaceSameMetadata(file, before, after) {
  const stat = fs.statSync(file), text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(before)); const changed = text.replace(before, after);
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(text));
  fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime);
}
async function warm(f, saved, extra = {}) {
  indexProjectGraph({ root: f.root });
  const request = q(f, saved, extra);
  // Re-priming can encounter the independent same-basis result cache after a
  // cold comparison. A nonmatching previousResult takes the existing public
  // original-backed path through remember, rather than that early return.
  const cold = await queryProjectGraph({ ...request, previousResult: { resultId: "not-a-retained-prime-result" } });
  assert.equal(cold.reuse.status, "fresh-read");
  const reused = await queryProjectGraph({ ...request, previousResult: cold });
  assert.equal(reused.reuse.status, "scoped-originals-reused");
  assert.equal(reused.reuse.wholeProjectCurrent, false);
  assert.deepEqual(reused.nodes, cold.nodes); assert.deepEqual(reused.edges, cold.edges);
  noAuthority(reused); return { request, cold, reused };
}
// Only the current selected payload/incident navigation is compared with a new
// original-backed discovery. Retained inventory/layer/exclusion diagnostics are
// deliberately not represented as a fresh whole-Project observation.
const selectedProjection = result => ({ nodes: result.nodes, edges: result.edges, boundary: result.boundary,
  unmatchedAnchorIds: result.unmatchedAnchorIds, omittedMatchCount: result.omittedMatchCount, truncated: result.truncated });
async function compareWithCold(request, actual) {
  // A deliberately nonmatching previous result uses the existing cold path;
  // callers neither seed the private cache nor supply verification authority.
  const cold = await queryProjectGraph({ ...request, previousResult: { resultId: "not-a-retained-result" } });
  assert.notEqual(cold.reuse.status, "scoped-originals-reused");
  assert.deepEqual(selectedProjection(actual), selectedProjection(cold));
  noAuthority(actual); noAuthority(cold); return cold;
}
function changeValidHeader(saved) {
  const stat = fs.statSync(saved.file), bytes = fs.readFileSync(saved.file), { evidenceDigest, ...payload } = JSON.parse(bytes);
  payload.recordedAt = new Date(Date.parse(payload.recordedAt) + 1000).toISOString();
  const evidence = { ...payload, evidenceDigest: sha(encoded(payload)) }, changed = JSON.stringify(evidence, null, 2) + "\n";
  assert.notEqual(evidence.evidenceDigest, evidenceDigest); assert.equal(Buffer.byteLength(changed), bytes.length);
  fs.writeFileSync(saved.file, changed); fs.utimesSync(saved.file, stat.atime, stat.mtime);
  saved.evidence = evidence; return bytes;
}

test("new default/named public work publications add exact index paths without scanning unrelated work bodies", t => {
  const f = fixture(t), defaultSaved = recordSessionWorkEvidence({ root: f.root, input: { summary: "Default work original" } });
  const unrelated = f.save({ summary: "Unrelated named work" });
  assert.ok(relative(f, defaultSaved.file).startsWith(`${f.layout.directory}/sessions/work-evidence/`));
  assert.ok(relative(f, unrelated.file).startsWith(`${f.layout.directory}/sessions/by-id/` + f.session.sessionId + "/work-evidence/"));
  const read = fs.readFileSync; let unrelatedReads = 0;
  fs.readFileSync = (file, ...args) => { if (file === unrelated.file) unrelatedReads++; return read(file, ...args); };
  let saved; try { saved = f.save({ summary: "New exact incremental work hint" }); } finally { fs.readFileSync = read; }
  assert.equal(saved.status, "session_work_evidence_recorded"); assert.equal(saved.writes, 1);
  assert.equal(unrelatedReads, 0, "A compatible mutation hint must not refresh every saved work body");
  const index = JSON.parse(fs.readFileSync(indexFile(f), "utf8"));
  for (const original of [defaultSaved, unrelated, saved]) {
    const entry = index.entries.find(item => item.path === relative(f, original.file));
    assert.ok(entry); assert.equal(entry.sha256, sha(fs.readFileSync(original.file)));
    assert.equal(entry.bytes, fs.statSync(original.file).size);
  }
  assert.ok(index.readerDependencies.sessionWork);
});

test("intact retry writes zero and never repairs an absent index or revalidates a disappeared dependency", t => {
  const f = fixture(t), root = f.save({ summary: "Root" }), input = { summary: "Already retained result", workLink: link(root), references: [citation(f, root)] };
  const saved = f.save(input); fs.unlinkSync(root.file); fs.unlinkSync(indexFile(f));
  const before = snapshot(f.base), read = fs.readFileSync; let indexReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === indexFile(f)) { indexReads++; throw new Error("Retry must not inspect/repair the graph index"); }
    return read(file, ...args);
  };
  let retried; try { retried = f.save(input); } finally { fs.readFileSync = read; }
  assert.equal(retried.status, "session_work_evidence_reused"); assert.equal(retried.writes, 0);
  assert.equal(retried.evidence.evidenceId, saved.evidence.evidenceId);
  assert.equal(retried.evidence.evidenceDigest, saved.evidence.evidenceDigest);
  assert.equal(retried.executionReplayAllowed, false); assert.equal(indexReads, 0);
  assert.equal(fs.existsSync(indexFile(f)), false); assert.deepEqual(snapshot(f.base), before);
});

test("post-commit graph publication failure preserves primary success and reports only deferred graph evidence", t => {
  const f = fixture(t); f.save({ summary: "Prime a compatible graph index" });
  const rename = fs.renameSync; let injected = 0;
  fs.renameSync = (source, target) => {
    if (target === indexFile(f)) { injected++; throw Object.assign(new Error("Synthetic derived failure"), { code: "EIO" }); }
    return rename(source, target);
  };
  let saved; try { saved = f.save({ summary: "Primary evidence survives failed graph update" }); } finally { fs.renameSync = rename; }
  assert.ok(injected > 0); assert.equal(saved.status, "session_work_evidence_recorded"); assert.equal(saved.writes, 1);
  assert.equal(saved.persisted, true); assert.equal(fs.existsSync(saved.file), true);
  assert.equal(saved.graphIndex.status, "deferred"); assert.equal(saved.graphIndex.ordinaryWorkBlocked, false);
  assert.ok(typeof saved.graphIndex.reasonCode === "string");
  const bytes = fs.readFileSync(saved.file), retried = f.save({ summary: "Primary evidence survives failed graph update" });
  assert.equal(retried.writes, 0); assert.deepEqual(fs.readFileSync(saved.file), bytes);
});

test("primary permission and post-publication acknowledgement failures remain errors, never deferred successes", t => {
  const f = fixture(t), linkSync = fs.linkSync;
  for (const published of [false, true]) {
    const input = { summary: "Primary error, published " + published }, before = snapshot(f.base);
    fs.linkSync = (source, target) => {
      if (String(target).includes("work-evidence")) {
        if (published) linkSync(source, target);
        throw Object.assign(new Error("Synthetic primary failure"), { code: published ? "EIO" : "EACCES" });
      }
      return linkSync(source, target);
    };
    try { assert.throws(() => f.save(input), { code: published ? "EIO" : "EACCES" }); } finally { fs.linkSync = linkSync; }
    if (!published) assert.deepEqual(snapshot(f.base), before);
    else {
      const afterFailure = snapshot(f.base), retry = f.save(input);
      assert.equal(retry.writes, 0); assert.equal(retry.status, "session_work_evidence_reused");
      assert.deepEqual(snapshot(f.base), afterFailure);
    }
  }
});

test("primary validation and partial staging writes fail before graph hints and preserve prior originals", t => {
  const f = fixture(t), before = snapshot(f.base);
  assert.throws(() => f.save({ summary: "No authority injection", approvedDecisions: ["Injected approval"] }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
  const open = fs.openSync, write = fs.writeFileSync, descriptors = new Set(); let injected = false;
  fs.openSync = (file, ...args) => {
    const descriptor = open(file, ...args);
    if (String(file).includes(".work-evidence-") && String(file).endsWith(".tmp")) descriptors.add(descriptor);
    return descriptor;
  };
  fs.writeFileSync = (file, content, ...args) => {
    if (descriptors.has(file)) {
      injected = true; write(file, String(content).slice(0, 31), ...args);
      throw Object.assign(new Error("Synthetic partial primary stage"), { code: "EIO" });
    }
    return write(file, content, ...args);
  };
  try { assert.throws(() => f.save({ summary: "Partial primary write is not graph deferred" }), { code: "EIO" }); }
  finally { fs.openSync = open; fs.writeFileSync = write; }
  assert.equal(injected, true); assert.deepEqual(snapshot(f.base), before);
});

test("primary staging cleanup failure propagates after publication and exact retry does not repair graph or replay work", t => {
  const f = fixture(t), unlink = fs.unlinkSync; let injected = false;
  fs.unlinkSync = file => {
    if (!injected && String(file).includes(".work-evidence-") && String(file).endsWith(".tmp")) {
      injected = true; throw Object.assign(new Error("Synthetic primary cleanup failure"), { code: "EIO" });
    }
    return unlink(file);
  };
  const input = { summary: "Published bytes with unconfirmed primary cleanup" };
  try { assert.throws(() => f.save(input), { code: "EIO" }); } finally { fs.unlinkSync = unlink; }
  assert.equal(injected, true);
  const afterFailure = snapshot(f.base), retry = f.save(input);
  assert.equal(retry.writes, 0); assert.equal(retry.status, "session_work_evidence_reused");
  assert.deepEqual(snapshot(f.base), afterFailure);
});

test("one malformed work original does not remove independent work or plan evidence", async t => {
  const f = fixture(t), bad = f.save({ summary: "Will become malformed" }), good = f.save({ summary: "Independent intact original" });
  const plan = f.route(() => createWholePlanSnapshot({ root: f.root, objective: "Independent plan", plan: ["Retain evidence"] }).artifact);
  fs.writeFileSync(bad.file, "{"); const before = snapshot(f.base);
  const result = await queryProjectGraph({ root: f.root, view: "work", details: true, maxNodes: 100 });
  assertWork(result, good); assert.equal(nodeFor(result, bad), undefined);
  assert.ok(result.nodes.some(node => node.nodeId === plan.wholePlanId));
  assert.ok(JSON.stringify(result.integrity.excluded).includes(relative(f, bad.file)));
  assert.deepEqual(snapshot(f.base), before);
});

test("a damaged named owner restricts its own work without default adoption or loss of another named owner", async t => {
  const f = fixture(t), bad = f.save({ summary: "Owner A work" });
  const second = createHeadSession({ root: f.root, purpose: "Independent owner B" });
  const good = withSessionRoute(f.root, second.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Owner B work" } }));
  const ownerFile = f.route(() => sessionStatePath(f.root));
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); owner.projectId = "head-" + "0".repeat(20);
  fs.writeFileSync(ownerFile, JSON.stringify(owner)); const before = snapshot(f.base);
  const result = await queryProjectGraph({ root: f.root, view: "work", details: true, maxNodes: 100 });
  assertWork(result, good); assert.equal(nodeFor(result, bad), undefined);
  assert.ok(result.edges.some(edge => edge.type === "RECORDED_FOR_SESSION" && edge.from === good.evidence.evidenceId && edge.to === second.sessionId));
  assert.deepEqual(snapshot(f.base), before);
  // Existing exact named routing tolerates unrelated malformed default JSON.
  fs.writeFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"), "{");
  const damagedDefault = snapshot(f.base), named = await queryProjectGraph(q(f, good));
  assertWork(named, good); assert.deepEqual(snapshot(f.base), damagedDefault);
});

test("missing/corrupt links preserve source selectors and independent observation target while excluding only affected edges", async t => {
  const f = fixture(t), root = f.save({ summary: "Context A" }), predecessor = f.save({ summary: "A predecessor", workLink: link(root) });
  const otherRoot = f.save({ summary: "Independent target B" });
  const saved = f.save({ summary: "A note observes B without merging membership", pending: ["X"], workLink: link(root, predecessor),
    executionObservation: { state: "ended", target: exact(otherRoot) } });
  let result = await queryProjectGraph(q(f, saved, { depth: 1, maxNodes: 20, maxEdges: 30 }));
  assertWork(result, saved);
  assert.ok(edgeFor(result, "DECLARES_WORK_ROOT", saved, root));
  assert.ok(edgeFor(result, "FOLLOWS_WORK_EVIDENCE", saved, predecessor));
  assert.ok(edgeFor(result, "SAVED_OBSERVATION_OF", saved, otherRoot));
  fs.unlinkSync(root.file); fs.writeFileSync(predecessor.file, "{}"); const before = snapshot(f.base);
  result = await queryProjectGraph(q(f, saved, { depth: 1, maxNodes: 20, maxEdges: 30 }));
  const node = assertWork(result, saved);
  assert.deepEqual(node.workContent.workLink, saved.evidence.content.workLink);
  assert.equal(edgeFor(result, "DECLARES_WORK_ROOT", saved, root), undefined);
  assert.equal(edgeFor(result, "FOLLOWS_WORK_EVIDENCE", saved, predecessor), undefined);
  assert.ok(edgeFor(result, "SAVED_OBSERVATION_OF", saved, otherRoot));
  assert.deepEqual(node.workContent.pending, ["X"]); assert.deepEqual(snapshot(f.base), before);
});

test("same evidence ID with a changed valid header digest does not satisfy an exact historical link selector", async t => {
  const f = fixture(t), root = f.save({ summary: "Root identity excludes recording time" });
  const saved = f.save({ summary: "Keep exact historical root selector", workLink: link(root) });
  const { evidenceDigest, ...payload } = root.evidence;
  payload.recordedAt = "2026-01-02T00:00:00.000Z";
  const changed = { ...payload, evidenceDigest: sha(encoded(payload)) };
  assert.notEqual(changed.evidenceDigest, evidenceDigest);
  fs.writeFileSync(root.file, JSON.stringify(changed, null, 2) + "\n");
  const before = snapshot(f.base), result = await queryProjectGraph(q(f, saved, { depth: 1, maxNodes: 10, maxEdges: 10 }));
  assertWork(result, saved);
  assert.deepEqual(nodeFor(result, saved).workContent.workLink.root, exact(root));
  assert.equal(edgeFor(result, "DECLARES_WORK_ROOT", saved, root), undefined);
  assert.equal(edgeFor(result, "FOLLOWS_WORK_EVIDENCE", saved, root), undefined);
  assert.deepEqual(snapshot(f.base), before);
});

test("depth>0 keeps the conservative hidden-owner/nonselected-work proof even with zero visible edges", async t => {
  const f = fixture(t), selected = f.save({ summary: "Exact anchor" });
  const other = createHeadSession({ root: f.root, purpose: "Unselected work owner" });
  const nonselected = withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Nonselected candidate" } }));
  const { request, reused } = await warm(f, selected, { depth: 1 }), before = snapshot(f.base);
  for (const file of [selected.file, nonselected.file, f.route(() => sessionStatePath(f.root)), path.join(f.root, f.layout.directory, "sessions/by-id", other.sessionId, "current.json")]) {
    assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, file)), "Missing hidden proof " + relative(f, file));
  }
  assert.deepEqual(snapshot(f.base), before);
  replaceSameMetadata(nonselected.file, "Nonselected candidate", "Nonselected corrupted");
  const after = snapshot(f.base), changed = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); assertWork(changed, selected);
  assert.deepEqual(snapshot(f.base), after);
});

test("A1 exact depth0 omits only independent valid work bytes, retains hidden owners and distinguishes retained global exclusions", async t => {
  const f = fixture(t), selected = f.save({ summary: "Exact useful anchor", pending: ["X"], unknowns: ["Effect unknown"] });
  const other = createHeadSession({ root: f.root, purpose: "Independent retained work owner" });
  const independent = withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root,
    input: { summary: "Independent candidate" } }));
  const { request, reused } = await warm(f, selected);
  assert.ok(!reused.integrity.verifiedRecordPaths.includes(relative(f, independent.file)));
  for (const file of [selected.file, f.route(() => sessionStatePath(f.root)),
    path.join(f.root, f.layout.directory, "sessions/by-id", other.sessionId, "current.json"), path.join(f.root, f.layout.directory, "sessions/current.json")]) {
    assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, file)), "Required owner/default proof " + relative(f, file));
  }
  changeValidHeader(independent);
  let before = snapshot(f.base), result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.equal(result.reuse.status, "scoped-originals-reused"); assertWork(result, selected);
  await compareWithCold(request, result); assert.deepEqual(snapshot(f.base), before);
  // Re-prime against the changed header before testing a separate independent
  // corruption. The fixture mutation is not a query-side repair/write.
  const again = await warm(f, selected);
  replaceSameMetadata(independent.file, "Independent candidate", "Independent corrupted");
  before = snapshot(f.base); result = await queryProjectGraph({ ...again.request, previousResult: again.reused });
  assert.equal(result.reuse.status, "scoped-originals-reused"); assertWork(result, selected);
  const cold = await compareWithCold(again.request, result);
  assert.deepEqual(result.integrity.excluded, again.reused.integrity.excluded);
  assert.deepEqual(result.sourceFallback.excludedInputs, again.reused.sourceFallback.excludedInputs);
  assert.notDeepEqual(cold.integrity.excluded, result.integrity.excluded, "Cold discovers a global exclusion that the retained diagnostic does not claim to refresh");
  assert.match(result.sourceFallback.action, /retain/i); assert.match(result.sourceFallback.action, /exclu/i);
  assert.equal(result.reuse.wholeProjectCurrent, false); assert.deepEqual(snapshot(f.base), before);
});

test("per-reference source/artifact kind and changed/missing facts do not overwrite intact work freshness", async t => {
  const f = fixture(t), sourceFile = path.join(f.root, "source.txt"), artifactFile = path.join(f.root, "retained.json");
  const projectId = f.route(() => JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"), "utf8")).projectId);
  fs.writeFileSync(sourceFile, "source version 11");
  fs.writeFileSync(artifactFile, JSON.stringify({ projectId, label: "Retained artifact" }));
  const source = { path: "source.txt", digest: sha(fs.readFileSync(sourceFile)), kind: "source" };
  const artifact = { path: "retained.json", digest: sha(fs.readFileSync(artifactFile)), kind: "artifact" };
  const saved = f.save({ summary: "Keep this intact historical work", pending: ["X"], references: [source, artifact] });
  const reversed = f.save({ summary: "Same reference facts, reversed order", references: [artifact, source] });
  const request = q(f, saved, { depth: 1, maxNodes: 20, maxEdges: 20 });
  let result = await queryProjectGraph(request), node = assertWork(result, saved);
  const freshness = node.freshness;
  const byPath = new Map(node.referenceEvidence.map(ref => [ref.path, ref]));
  assert.equal(byPath.get(source.path).status, "matching-current-bytes");
  assert.equal(byPath.get(artifact.path).status, "intact-retained-original");
  for (const ref of [source, artifact]) {
    const fact = byPath.get(ref.path);
    assert.equal(fact.kind, ref.kind); assert.equal(fact.digest, ref.digest);
    assert.equal(fact.currentness, "current"); assert.equal(fact.currentDigest, ref.digest);
    assert.equal(fact.contentReconstructed, false);
  }
  replaceSameMetadata(sourceFile, "11", "22"); fs.unlinkSync(artifactFile);
  const before = snapshot(f.base);
  result = await queryProjectGraph({ root: f.root, anchorIds: [saved.evidence.evidenceId, reversed.evidence.evidenceId],
    view: "work", details: true, depth: 1, maxNodes: 30, maxEdges: 30 });
  node = assertWork(result, saved); assert.equal(node.freshness, freshness);
  const facts = new Map(node.referenceEvidence.map(ref => [ref.path, ref]));
  assert.equal(facts.get(source.path).currentness, "changed");
  assert.equal(facts.get(source.path).currentDigest, sha(fs.readFileSync(sourceFile)));
  assert.equal(facts.get(artifact.path).currentness, "missing");
  assert.equal(facts.get(artifact.path).currentDigest, null);
  for (const fact of facts.values()) {
    assert.equal(fact.status, "unavailable"); assert.equal(fact.historicalContentAvailable, false);
    assert.equal(fact.contentReconstructed, false);
  }
  const sort = refs => [...refs].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sort(node.referenceEvidence), sort(nodeFor(result, reversed).referenceEvidence));
  assert.deepEqual(node.workContent.pending, ["X"]); assert.deepEqual(snapshot(f.base), before);
});

test("two retained file digests stay separate while exact work citations verify the actual cross-Session owner", async t => {
  const f = fixture(t), sourceFile = path.join(f.root, "versioned.txt");
  fs.writeFileSync(sourceFile, "version 11");
  const ref11 = { path: "versioned.txt", digest: sha(fs.readFileSync(sourceFile)), kind: "source" };
  const first = f.save({ summary: "First retained revision", references: [ref11] });
  replaceSameMetadata(sourceFile, "11", "22");
  const ref22 = { ...ref11, digest: sha(fs.readFileSync(sourceFile)) };
  const other = createHeadSession({ root: f.root, purpose: "Actual cited work owner" });
  const target = withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Cross-Session cited evidence" } }));
  const second = f.save({ summary: "Second retained revision", references: [ref22, citation(f, target)] });
  const before = snapshot(f.base), result = await queryProjectGraph({ root: f.root,
    anchorIds: [first.evidence.evidenceId, second.evidence.evidenceId], view: "work", details: true, depth: 1, maxNodes: 30, maxEdges: 40 });
  assertWork(result, first); assertWork(result, second); assertWork(result, target);
  assert.equal(nodeFor(result, first).referenceEvidence.find(ref => ref.path === ref11.path).currentness, "changed");
  assert.equal(nodeFor(result, second).referenceEvidence.find(ref => ref.path === ref22.path).currentness, "current");
  assert.ok(edgeFor(result, "CITES_WORK_EVIDENCE", second, target));
  assert.equal(nodeFor(result, target).sessionId, other.sessionId);
  assert.equal(nodeFor(result, second).sessionId, f.session.sessionId);
  const firstRevision = result.edges.find(edge => edge.type === "CITES_EXACT_REVISION" && edge.from === first.evidence.evidenceId);
  const secondRevision = result.edges.find(edge => edge.type === "CITES_EXACT_REVISION" && edge.from === second.evidence.evidenceId
    && result.nodes.find(node => node.nodeId === edge.to)?.path === ref22.path);
  assert.ok(firstRevision); assert.ok(secondRevision); assert.notEqual(firstRevision.to, secondRevision.to);
  assert.deepEqual(snapshot(f.base), before);
});

test("identical file bytes cited as source and artifact preserve both explicit reference kinds", async t => {
  const f = fixture(t), file = path.join(f.root, "dual-kind.json");
  const projectId = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "project.json"), "utf8")).projectId;
  fs.writeFileSync(file, JSON.stringify({ projectId, label: "Same physical bytes" }));
  const digest = sha(fs.readFileSync(file)), saved = f.save({ summary: "Explicit kinds are not interchangeable", references: [
    { path: "dual-kind.json", digest, kind: "source" }, { path: "dual-kind.json", digest, kind: "artifact" },
  ] });
  const result = await queryProjectGraph(q(f, saved, { depth: 1, maxNodes: 10, maxEdges: 10 }));
  const node = assertWork(result, saved);
  assert.deepEqual(node.referenceEvidence.map(ref => ref.kind).sort(), ["artifact", "source"]);
  assert.equal(result.edges.filter(edge => edge.type === "CITES_EXACT_REVISION" && edge.from === saved.evidence.evidenceId).length, 2);
});

test("reference bytes and missing-file creation invalidate exact warm reuse even when work and owner bytes are unchanged", async t => {
  const f = fixture(t), file = path.join(f.root, "proof-source.txt");
  fs.writeFileSync(file, "proof source 11");
  const reference = { path: "proof-source.txt", digest: sha(fs.readFileSync(file)), kind: "source" };
  const saved = f.save({ summary: "Reference-dependent exact anchor", references: [reference] });
  const { request, reused } = await warm(f, saved);
  replaceSameMetadata(file, "11", "22"); let before = snapshot(f.base);
  let result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  assert.equal(nodeFor(result, saved).referenceEvidence[0].currentness, "changed"); assert.deepEqual(snapshot(f.base), before);
  fs.unlinkSync(file); indexProjectGraph({ root: f.root });
  const absent = await queryProjectGraph(request), absentRepeat = await queryProjectGraph({ ...request, previousResult: absent });
  assert.equal(nodeFor(absentRepeat, saved).referenceEvidence[0].currentness, "missing");
  fs.writeFileSync(file, "proof source 11"); before = snapshot(f.base);
  result = await queryProjectGraph({ ...request, previousResult: absentRepeat });
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  assert.equal(nodeFor(result, saved).referenceEvidence[0].currentness, "current"); assert.deepEqual(snapshot(f.base), before);
});

test("restoring an excluded same-path producer discovers its incoming relation via proof invalidation or safe cold fallback", async t => {
  const f = fixture(t), root = f.save({ summary: "Exact root anchor" }), producer = f.save({ summary: "Incoming producer", workLink: link(root) });
  const bytes = fs.readFileSync(producer.file); fs.writeFileSync(producer.file, "{}");
  indexProjectGraph({ root: f.root });
  const request = q(f, root, { depth: 1, maxNodes: 20, maxEdges: 20 }), cold = await queryProjectGraph(request);
  // A damaged dependency may legitimately prevent priming scoped reuse.
  const reused = await queryProjectGraph({ ...request, previousResult: cold });
  assert.equal(nodeFor(reused, producer), undefined);
  fs.writeFileSync(producer.file, bytes); const before = snapshot(f.base);
  const restored = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(restored.reuse.status, "scoped-originals-reused"); assertWork(restored, producer);
  assert.ok(edgeFor(restored, "DECLARES_WORK_ROOT", producer, root)); assert.deepEqual(snapshot(f.base), before);
});

test("text/path/exact discovery performs no sync or async file writes and leaves current Session/P2 originals unchanged", async t => {
  const f = fixture(t), saved = f.save({ judgments: [{ assessment: "Choose B", reason: "Proof sentinel reason", alternatives: ["Keep A"] }], pending: ["X"] });
  const sequence = await warm(f, saved);
  const before = snapshot(f.base), originals = [], attempts = [];
  const trap = name => (...args) => { attempts.push(name); throw new Error("Read-only graph attempted " + name); };
  const replace = (object, name, value) => { originals.push([object, name, object[name]]); object[name] = value; };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "renameSync", "linkSync", "rmSync", "copyFileSync", "truncateSync"]) replace(fs, name, trap(name));
  for (const name of ["writeFile", "appendFile", "mkdir", "unlink", "rename", "link", "rm", "copyFile", "truncate"]) replace(fsp, name, trap("promises." + name));
  const openSync = fs.openSync, open = fsp.open;
  replace(fs, "openSync", (file, flags, ...args) => {
    if (typeof flags !== "string" || flags !== "r") return trap("openSync-write")(file, flags);
    return openSync(file, flags, ...args);
  });
  replace(fsp, "open", (file, flags, ...args) => {
    if (typeof flags !== "string" || flags !== "r") return trap("promises.open-write")(file, flags);
    return open(file, flags, ...args);
  });
  syncBuiltinESMExports();
  try {
    const repeated = await queryProjectGraph({ ...sequence.request, previousResult: sequence.reused });
    assert.equal(repeated.reuse.status, "scoped-originals-reused"); assertWork(repeated, saved);
    for (const options of [q(f, saved), { root: f.root, paths: [relative(f, saved.file)], details: true },
      { root: f.root, query: "Proof sentinel reason", details: true }]) assertWork(await queryProjectGraph(options), saved);
  } finally {
    for (const [object, name, value] of originals.reverse()) object[name] = value;
    syncBuiltinESMExports();
  }
  assert.deepEqual(attempts, []); assert.deepEqual(snapshot(f.base), before);
});

test("external named work membership without an index hint is rediscovered rather than silently omitted", async t => {
  const f = fixture(t), selected = f.save({ summary: "Existing anchor" });
  const external = createHeadSession({ root: f.root, purpose: "Initially empty candidate owner" });
  const published = withSessionRoute(f.root, external.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "External candidate work" } }));
  const bytes = fs.readFileSync(published.file); fs.unlinkSync(published.file);
  const { request, reused } = await warm(f, selected);
  fs.writeFileSync(published.file, bytes); const before = snapshot(f.base);
  const result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused"); assertWork(result, selected);
  const freshQuestion = await queryProjectGraph({ root: f.root, query: "External candidate work", details: true });
  assertWork(freshQuestion, published); assert.deepEqual(snapshot(f.base), before);
});

test("an externally appearing named Session plus work directory invalidates membership without an index repair", async t => {
  const f = fixture(t), selected = f.save({ summary: "Existing exact anchor" });
  const external = createHeadSession({ root: f.root, purpose: "New external named owner" });
  const saved = withSessionRoute(f.root, external.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "New named owner evidence" } }));
  const directory = path.join(f.root, f.layout.directory, "sessions/by-id", external.sessionId), parked = path.join(f.base, "parked-owner");
  fs.renameSync(directory, parked); // Both exact paths belong to this fixture.
  const { request, reused } = await warm(f, selected);
  fs.renameSync(parked, directory);
  const before = snapshot(f.base), result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused"); assertWork(result, selected);
  const discovered = await queryProjectGraph(q(f, saved)); assertWork(discovered, saved);
  assert.deepEqual(snapshot(f.base), before);
});

test("same-path owner tampering invalidates warm proof instead of retaining a formerly valid work owner", async t => {
  const f = fixture(t), selected = f.save({ summary: "Owner-bound original" }), { request, reused } = await warm(f, selected);
  const file = f.route(() => sessionStatePath(f.root)), owner = JSON.parse(fs.readFileSync(file, "utf8"));
  const replacement = owner.projectId.endsWith("0") ? "1" : "0";
  replaceSameMetadata(file, owner.projectId, owner.projectId.slice(0, -1) + replacement);
  const before = snapshot(f.base), result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused"); assert.equal(nodeFor(result, selected), undefined);
  noAuthority(result); assert.deepEqual(snapshot(f.base), before);
});

test("actual default Session identity is a hidden work dependency and a default/named collision cannot be adopted", async t => {
  const f = fixture(t), saved = recordSessionWorkEvidence({ root: f.root, input: { summary: "Default-owned original" } });
  const { request, reused } = await warm(f, saved);
  assert.ok(reused.integrity.verifiedRecordPaths.includes(`${f.layout.directory}/sessions/current.json`));
  assert.equal(nodeFor(reused, saved).sessionId, saved.evidence.sessionId);
  const file = path.join(f.root, f.layout.directory, "sessions/current.json"), state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.sessionId = f.session.sessionId; fs.writeFileSync(file, JSON.stringify(state));
  const before = snapshot(f.base), result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused"); assert.equal(nodeFor(result, saved), undefined);
  noAuthority(result); assert.deepEqual(snapshot(f.base), before);
});

test("old/no work index uses originals without query-time repair or Session selection changes", async t => {
  const f = fixture(t), saved = f.save({ summary: "Original-backed discovery" });
  for (const mode of ["old", "absent"]) {
    if (mode === "old") {
      const index = JSON.parse(fs.readFileSync(indexFile(f), "utf8")); delete index.readerDependencies.sessionWork;
      index.entries = index.entries.filter(entry => !entry.path.includes("/work-evidence/"));
      fs.writeFileSync(indexFile(f), JSON.stringify(index));
    } else fs.unlinkSync(indexFile(f));
    const before = snapshot(f.base), defaultState = fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json"));
    const selectedState = f.route(() => fs.readFileSync(sessionStatePath(f.root)));
    const result = await queryProjectGraph(q(f, saved)); assertWork(result, saved);
    assert.notEqual(result.reuse.status, "scoped-originals-reused");
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.layout.directory, "sessions/current.json")), defaultState);
    assert.deepEqual(f.route(() => fs.readFileSync(sessionStatePath(f.root))), selectedState);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test("A1 selected header bytes remain fresh despite identical size/mtime, and a returned clone cannot mutate private cache state", async t => {
  const f = fixture(t), selected = f.save({ summary: "Selected header must be current", pending: ["X"] });
  const { request, reused } = await warm(f, selected), retained = structuredClone(reused);
  reused.nodes[0].workContent.pending.push("Caller injection"); reused.boundary.nextAnchorIds.push("Caller anchor");
  const isolated = await queryProjectGraph({ ...request, previousResult: retained });
  assert.equal(isolated.reuse.status, "scoped-originals-reused");
  assert.deepEqual(selectedProjection(isolated), selectedProjection(retained));
  changeValidHeader(selected); const before = snapshot(f.base);
  const changed = await queryProjectGraph({ ...request, previousResult: isolated });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); assertWork(changed, selected);
  assert.notEqual(nodeFor(changed, selected).sourceReference.digest, nodeFor(isolated, selected).sourceReference.digest);
  await compareWithCold(request, changed); assert.deepEqual(snapshot(f.base), before);
});

for (const mode of ["root", "observation", "potential-citation", "potential-source"]) test(`A1 ${mode} producer header remains a proof dependency even when no current citation edge exists`, async t => {
  const f = fixture(t), selected = f.save({ summary: "Selected producer target" });
  const producer = f.save(mode === "root" ? { summary: "Related root producer", workLink: link(selected) }
    : mode === "observation" ? { executionObservation: { state: "paused", target: exact(selected) } }
      : { summary: "Potential exact-path reference producer", references: [{ ...citation(f, selected), kind: mode === "potential-source" ? "source" : "artifact" }] });
  if (mode === "potential-citation") changeValidHeader(selected); // P's retained artifact digest is now stale, but its exact path is still potential.
  const { request, reused } = await warm(f, selected);
  assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, producer.file)));
  const originalBoundary = structuredClone(reused.boundary);
  changeValidHeader(producer); const before = snapshot(f.base);
  const changed = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); assertWork(changed, selected);
  if (mode === "root" || mode === "observation") assert.notDeepEqual(changed.boundary, originalBoundary, "Current producer raw provenance changes its incident edge identity");
  await compareWithCold(request, changed); assert.deepEqual(snapshot(f.base), before);
});

for (const mode of ["missing", "digest-mismatch"]) test(`A1 hidden root gate ${mode} restoration discovers the previously suppressed incoming predecessor boundary`, async t => {
  const f = fixture(t), root = f.save({ summary: "Separate required root gate" });
  const selected = f.save({ summary: "Selected predecessor", workLink: link(root) });
  const producer = f.save({ summary: "Potential follows producer", workLink: link(root, selected) });
  const rootBytes = fs.readFileSync(root.file);
  if (mode === "missing") fs.unlinkSync(root.file); else changeValidHeader(root);
  const { request, reused } = await warm(f, selected);
  assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, producer.file)));
  if (mode !== "missing") assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, root.file)));
  assert.ok(!reused.boundary.nextAnchorIds.includes(producer.evidence.evidenceId));
  fs.writeFileSync(root.file, rootBytes); const before = snapshot(f.base);
  const restored = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(restored.reuse.status, "scoped-originals-reused"); assertWork(restored, selected);
  assert.ok(restored.boundary.nextAnchorIds.includes(producer.evidence.evidenceId));
  await compareWithCold(request, restored); assert.deepEqual(snapshot(f.base), before);
});

test("A1 same-path invalid producer and unowned original restoration cannot be mistaken for independent valid work", async t => {
  const f = fixture(t), selected = f.save({ summary: "Independent valid selected original" });
  const producer = f.save({ summary: "Initially invalid incoming producer", workLink: link(selected) });
  const producerBytes = fs.readFileSync(producer.file); fs.writeFileSync(producer.file, "{}");
  let sequence = await warm(f, selected);
  assert.ok(sequence.reused.integrity.verifiedRecordPaths.includes(relative(f, producer.file)));
  fs.writeFileSync(producer.file, producerBytes); let before = snapshot(f.base);
  let result = await queryProjectGraph({ ...sequence.request, previousResult: sequence.reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  assert.ok(result.boundary.nextAnchorIds.includes(producer.evidence.evidenceId));
  await compareWithCold(sequence.request, result); assert.deepEqual(snapshot(f.base), before);
  const other = createHeadSession({ root: f.root, purpose: "Temporarily invalid owner" });
  const unowned = withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root,
    input: { summary: "Unowned exact citation producer", references: [citation(f, selected)] } }));
  const ownerPath = path.join(f.root, f.layout.directory, "sessions/by-id", other.sessionId, "current.json");
  const ownerBytes = fs.readFileSync(ownerPath), state = JSON.parse(ownerBytes);
  state.projectId = "head-" + "0".repeat(20); fs.writeFileSync(ownerPath, JSON.stringify(state));
  // A bad generic Session layer may make the existing proof unsupported; this
  // is legitimate cold fallback, not a reason to weaken owner verification.
  indexProjectGraph({ root: f.root });
  const request = q(f, selected), absent = await queryProjectGraph(request);
  const repeated = await queryProjectGraph({ ...request, previousResult: absent });
  assert.equal(nodeFor(repeated, unowned), undefined);
  assert.ok(!repeated.boundary.nextAnchorIds.includes(unowned.evidence.evidenceId));
  const workBytes = fs.readFileSync(unowned.file); fs.writeFileSync(ownerPath, ownerBytes);
  before = snapshot(f.base); result = await queryProjectGraph({ ...request, previousResult: repeated });
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  assert.ok(result.boundary.nextAnchorIds.includes(unowned.evidence.evidenceId));
  assert.deepEqual(fs.readFileSync(unowned.file), workBytes, "Only the real owner was repaired, not the work original");
  await compareWithCold(request, result); assert.deepEqual(snapshot(f.base), before);
});

for (const field of ["activeRunId", "lastResultPacketId", "latestCheckpoint", "currentWholePlanId"]) test(`A1 retains another named owner's mutable ${field} even when it newly points to a work ID`, async t => {
  const f = fixture(t), selected = f.save({ summary: "Incoming generic state target" });
  const other = createHeadSession({ root: f.root, purpose: "Mutable nonselected owner" });
  withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Independent owned work" } }));
  const ownerPath = path.join(f.root, f.layout.directory, "sessions/by-id", other.sessionId, "current.json");
  const { request, reused } = await warm(f, selected);
  assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, ownerPath)));
  const state = JSON.parse(fs.readFileSync(ownerPath)); state[field] = selected.evidence.evidenceId;
  fs.writeFileSync(ownerPath, JSON.stringify(state)); const before = snapshot(f.base);
  const changed = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); assertWork(changed, selected);
  assert.ok(changed.boundary.nextAnchorIds.includes(other.sessionId));
  await compareWithCold(request, changed); assert.deepEqual(snapshot(f.base), before);
});

test("A1 shared selected reference wins over independent-work exclusion, retaining separate source/artifact facts through changed/missing/reappeared bytes", async t => {
  const f = fixture(t), file = path.join(f.root, "shared-selected.json");
  fs.writeFileSync(file, JSON.stringify({ projectId: f.session.projectId, value: "shared 11" }));
  const bytes = fs.readFileSync(file), references = ["source", "artifact"].map(kind => ({ path: "shared-selected.json", digest: sha(bytes), kind }));
  const selected = f.save({ summary: "Selected reference-dependent body", references });
  const independent = f.save({ summary: "Independent sibling shares physical bytes", references });
  for (const mutate of [() => replaceSameMetadata(file, "11", "22"), () => fs.unlinkSync(file), () => fs.writeFileSync(file, bytes)]) {
    const { request, reused } = await warm(f, selected);
    // A shared FileRevisionReference is a first-hop required node. Its origin
    // can be this sibling's work path under inventory ordering, so the accepted
    // conservative origin rule may retain that work too. The no-ref A1 case
    // separately requires genuinely independent work exclusion; here selected
    // descriptor/raw-reference proof takes precedence over removal savings.
    const siblingRetained = reused.integrity.verifiedRecordPaths.includes(relative(f, independent.file));
    t.diagnostic(`Shared-reference sibling proof retained=${siblingRetained}; first-hop FileRevisionReference origin may conservatively retain it. Selected reference proof/currentness and cold boundary equality remain required.`);
    if (fs.existsSync(file)) assert.ok(reused.integrity.verifiedRecordPaths.includes("shared-selected.json"));
    mutate(); const before = snapshot(f.base), changed = await queryProjectGraph({ ...request, previousResult: reused });
    assert.notEqual(changed.reuse.status, "scoped-originals-reused");
    const facts = nodeFor(changed, selected).referenceEvidence;
    assert.deepEqual(facts.map(ref => ref.kind).sort(), ["artifact", "source"]);
    assert.ok(facts.every(ref => ref.contentReconstructed === false));
    assert.ok(facts.every(ref => ref.currentDigest === (fs.existsSync(file) ? sha(fs.readFileSync(file)) : null)));
    await compareWithCold(request, changed); assert.deepEqual(snapshot(f.base), before);
  }
});

test("A1 requires every exact anchor to be returned; partial/unmatched anchors retain conservative behavior rather than hiding omitted matches", async t => {
  const f = fixture(t), first = f.save({ summary: "First requested anchor" }), second = f.save({ summary: "Second requested anchor" });
  const independent = f.save({ summary: "Unrelated independent sibling" }), anchorIds = [first.evidence.evidenceId, second.evidence.evidenceId];
  const all = await warm(f, first, { anchorIds, maxNodes: 2 });
  assert.equal(all.reused.nodes.length, 2); assert.equal(all.reused.omittedMatchCount, 0);
  assert.ok(!all.reused.integrity.verifiedRecordPaths.includes(relative(f, independent.file)));
  const partial = await warm(f, first, { anchorIds, maxNodes: 1 });
  assert.equal(partial.reused.nodes.length, 1); assert.equal(partial.reused.omittedMatchCount, 1);
  assert.ok(partial.reused.integrity.verifiedRecordPaths.includes(relative(f, independent.file)));
  replaceSameMetadata(independent.file, "Unrelated independent sibling", "Unrelated independent corrupt");
  const before = snapshot(f.base), changed = await queryProjectGraph({ ...partial.request, previousResult: partial.reused });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); await compareWithCold(partial.request, changed);
  const request = q(f, first, { anchorIds: [first.evidence.evidenceId, "work-evidence-" + "0".repeat(24)], maxNodes: 2 });
  const cold = await queryProjectGraph(request), repeat = await queryProjectGraph({ ...request, previousResult: cold });
  assert.notEqual(repeat.reuse.status, "scoped-originals-reused"); assert.equal(repeat.unmatchedAnchorIds.length, 1);
  assert.deepEqual(snapshot(f.base), before);
});

test("A1 selected inventory identity ambiguity preserves raw duplicate/independent proofs instead of classifying an origin by node ID alone", async t => {
  const f = fixture(t), selected = f.save({ summary: "Exact selected identity" }), independent = f.save({ summary: "Independent original" });
  const other = createHeadSession({ root: f.root, purpose: "Duplicate path owner" });
  const otherWork = withSessionRoute(f.root, other.sessionId, () => recordSessionWorkEvidence({ root: f.root, input: { summary: "Other owner work" } }));
  const duplicate = path.join(path.dirname(otherWork.file), path.basename(selected.file));
  fs.copyFileSync(selected.file, duplicate); // Public bytes, deliberately wrong owner at this second recognized path.
  const { request, reused } = await warm(f, selected);
  assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, duplicate)));
  assert.ok(reused.integrity.verifiedRecordPaths.includes(relative(f, independent.file)));
  replaceSameMetadata(independent.file, "Independent original", "Independent corrupt!");
  const before = snapshot(f.base), changed = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(changed.reuse.status, "scoped-originals-reused"); assertWork(changed, selected);
  await compareWithCold(request, changed); assert.deepEqual(snapshot(f.base), before);
});

test("A1 late index change after the hit's single index observation is a sequential boundary, not a promised post-proof recheck", async t => {
  const f = fixture(t), selected = f.save({ summary: "Stable selected body through late index drift" });
  const { request, reused } = await warm(f, selected), read = fs.readFileSync;
  const originalIndex = fs.readFileSync(indexFile(f)); let injected = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = read(file, ...args);
    if (path.resolve(String(file)) === path.resolve(indexFile(f)) && !injected) {
      injected = true; fs.appendFileSync(indexFile(f), " ");
    }
    return bytes;
  };
  let value; try { value = await queryProjectGraph({ ...request, previousResult: reused }); } finally { fs.readFileSync = read; }
  assert.equal(injected, true); assert.equal(value.reuse.status, "scoped-originals-reused");
  assert.deepEqual(selectedProjection(value), selectedProjection(reused));
  assert.notDeepEqual(fs.readFileSync(indexFile(f)), originalIndex);
  const before = snapshot(f.base), next = await queryProjectGraph({ ...request, previousResult: value });
  assert.notEqual(next.reuse.status, "scoped-originals-reused"); assertWork(next, selected);
  await compareWithCold(request, next); assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Fault injection writes the synthetic index after its observed bytes are returned; this is not an atomic/latest-at-return or query-write claim.");
});

for (const kind of ["selected", "reference"]) test(`A1 ${kind} file-to-directory layout change invalidates warm reuse without read-side repair`, async t => {
  const f = fixture(t), referencePath = path.join(f.root, "required-layout.txt"); fs.writeFileSync(referencePath, "Required exact bytes");
  const selected = f.save({ summary: "Layout-bound selected evidence", references: [{ path: "required-layout.txt", digest: sha(fs.readFileSync(referencePath)), kind: "source" }] });
  const { request, reused } = await warm(f, selected), file = kind === "selected" ? selected.file : referencePath;
  fs.unlinkSync(file); fs.mkdirSync(file); const before = snapshot(f.base);
  const result = await queryProjectGraph({ ...request, previousResult: reused });
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  if (kind === "selected") assert.equal(nodeFor(result, selected), undefined);
  else { assertWork(result, selected); assert.equal(nodeFor(result, selected).referenceEvidence[0].status, "unavailable"); }
  await compareWithCold(request, result); assert.deepEqual(snapshot(f.base), before);
});

test("B navigation publication leaves graph inventory identity unchanged and cold collection adds no header-verification pass", async t => {
  const f = fixture(t), root = f.save({ summary: "Original graph root" });
  const latest = f.save({ pending: ["Original graph pending X"], workLink: link(root) });
  indexProjectGraph({ root: f.root });
  const published = JSON.parse(fs.readFileSync(indexFile(f))), legacy = { ...published };
  assert.equal(published.sessionWorkNavigation.rows.length, 2);
  delete legacy.sessionWorkNavigation;
  fs.writeFileSync(indexFile(f), JSON.stringify(legacy)); // Pre-read legacy fixture, not a reader repair.
  const before = snapshot(f.base), parse = JSON.parse; let workParses = 0;
  JSON.parse = function (...args) {
    const value = parse.apply(this, args);
    if (value?.kind === "Evidence" && value.subtype === "SessionWorkEvidence") workParses++;
    return value;
  };
  let collected; try { collected = collectProjectGraphInventory(f.root); } finally { JSON.parse = parse; }
  assert.equal(workParses, 2, "Existing dependency normalization only; navigation production must not run in collection");
  for (const field of ["entries", "unavailable", "complete", "readerDependencies", "recordsDigest"]) assert.deepEqual(collected[field], published[field]);
  const query = await queryProjectGraph(q(f, latest)); assertWork(query, latest);
  assert.deepEqual(snapshot(f.base), before);
  indexProjectGraph({ root: f.root }); // Legitimate publication outside the read snapshot.
  const restored = JSON.parse(fs.readFileSync(indexFile(f)));
  for (const field of ["entries", "unavailable", "complete", "readerDependencies", "recordsDigest"]) assert.deepEqual(restored[field], legacy[field]);
  assert.deepEqual(restored.sessionWorkNavigation, published.sessionWorkNavigation);
});

test("B navigation-only index replacement conservatively invalidates A1 raw-index reuse without changing original graph output", async t => {
  const f = fixture(t), saved = f.save({ summary: "Stable graph contents through optional header change" });
  indexProjectGraph({ root: f.root });
  const request = q(f, saved), first = await queryProjectGraph(request), warmResult = await queryProjectGraph(request);
  assert.equal(warmResult.reuse.status, "scoped-originals-reused");
  const index = JSON.parse(fs.readFileSync(indexFile(f))); delete index.sessionWorkNavigation;
  fs.writeFileSync(indexFile(f), JSON.stringify(index));
  const before = snapshot(f.base), observed = await queryProjectGraph(request);
  assert.notEqual(observed.reuse.status, "scoped-originals-reused");
  assert.deepEqual(selectedProjection(observed), selectedProjection(first));
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Actual metadata-invalidation reuse state: " + observed.reuse.status + "; not relabelled as a fresh read or reseed");
});
