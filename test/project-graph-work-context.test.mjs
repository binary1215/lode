import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { readProjectDirection, updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { startFeatureMapping, reviewFeatureMapping } from "../scripts/lib/feature-mapping.mjs";
import { sha, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { assertTerminalGraphPresentation } from "./helpers/terminal-graph-assertions.mjs";
import { buildGraphExplorerSnapshot, exportGraphExplorer } from "../scripts/lib/graph-explorer.mjs";
import { explorerDom } from "./helpers/graph-explorer-dom-fixture.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const isWork = node => node.kind === "Evidence" && node.subtype === "SessionWorkEvidence";
const workNodes = value => value.nodes.filter(isWork);
function assertJsonMember(text, name, value) {
  if (value !== undefined) assert.ok(text.includes(JSON.stringify({ [name]: value }, null, 2).slice(2, -2)), `Missing original ${name}`);
}
function assertLiteralValues(text, value) {
  if (typeof value === "string") assert.ok(text.includes(value) || text.includes(JSON.stringify(value)), `Missing original literal: ${value}`);
  else if (Array.isArray(value)) for (const item of value) assertLiteralValues(text, item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) assertLiteralValues(text, item);
}
function assertCommonNodes(text, nodes) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const members = nodes.map((value, index) => ({ value, index })).filter(({ value }) => object(value) && Object.hasOwn(value, "workContent"));
  const first = members[0]?.value;
  const eligible = members.length >= 2 && members.every(({ value }) => ["projectId", "sessionId", "kind", "subtype", "workContent"].every(key => Object.hasOwn(value, key))
    && value.kind === "Evidence" && value.subtype === "SessionWorkEvidence" && object(value.workContent)
    && ["projectId", "sessionId"].every(key => typeof value[key] === "string" && value[key].length > 0 && value[key] === first[key]));
  const expected = eligible ? Object.fromEntries(["projectId", "sessionId", "kind", "subtype", "schemaVersion", "protocol", "authorityBoundary"]
    .filter(key => Object.hasOwn(first, key) && members.every(({ value }) => Object.hasOwn(value, key)
      && typeof value[key] === typeof first[key] && JSON.stringify(value[key]) === JSON.stringify(first[key])))
    .map(key => [key, first[key]])) : {};
  const blocks = [...text.matchAll(/^Common stored fields for (.+):\n/gmu)];
  assert.equal(blocks.length, Object.keys(expected).length ? 1 : 0);
  if (blocks.length) {
    const block = blocks[0], firstNode = text.search(/^Node\[\d+\]:\n/mu);
    assert.equal(block[1], members.map(({ index }) => `Node[${index}]`).join(", "), "Common membership uses original node indices, never navigation nodes");
    assert.ok(block.index < firstNode);
    const encoded = text.slice(block.index + block[0].length).match(/^\{[\s\S]*?\n\}/u);
    assert.ok(encoded, "Common fields remain one exact JSON object before grouped bodies");
    assert.deepEqual(JSON.parse(encoded[0]), expected);
  }
  return expected;
}
function assertGraphPresentation(text, value) {
  if (text.startsWith("Selected connections:")) return assertTerminalGraphPresentation(text, value);
  const common = assertCommonNodes(text, value.nodes);
  for (const name of ["coverage", "sourceFallback", "boundary"]) assertJsonMember(text, name, value[name]);
  for (const [index, node] of value.nodes.entries()) {
    const heading = `\nNode[${index}]:\n`, start = text.indexOf(heading);
    assert.ok(start >= 0, `Missing Node[${index}]`);
    assert.equal(text.split(heading).length - 1, 1, `Node[${index}] body is displayed once`);
    const following = text.slice(start + heading.length).search(/^(?:Node\[\d+\]:|Edge\[\d+\]:|Session work group \(|Additional original fields at graph:)/mu);
    const end = following < 0 ? [] : [start + heading.length + following];
    const section = text.slice(start, end.length ? Math.min(...end) : undefined);
    assert.ok(section.includes(`nodeId: ${JSON.stringify(node.nodeId)}`));
    if (!isWork(node) && node.sessionId !== undefined) assert.ok(section.includes(`sessionId: ${JSON.stringify(node.sessionId)}`));
    if (isWork(node)) {
      for (const name of ["projectId", "sessionId", "kind", "subtype"]) {
        if (Object.hasOwn(node, name)) assert.equal(section.split("\n").includes(`${name}: ${JSON.stringify(node[name])}`),
          !Object.hasOwn(common, name), `Node[${index}] ${name} must be local or exact common`);
      }
      assertLiteralValues(section, node.workContent);
      for (const name of ["evidenceDigest", "referenceEvidence", "originalExpansion"]) assertJsonMember(section, name, node[name]);
      if (node.workContentCoverage) {
        const { partial, ...residual } = node.workContentCoverage;
        assert.ok(section.includes(`workContentCoverage.partial: ${JSON.stringify(partial)}`));
        for (const [name, value] of Object.entries(residual)) assertJsonMember(section, name, value);
      }
      if (node.workContentExcerpts) {
        if (!node.workContentExcerpts.length) assert.ok(section.includes("workContentExcerpts: []"));
        for (const [excerptIndex, excerpt] of node.workContentExcerpts.entries()) {
          const location = `workContentExcerpts[${excerptIndex}]`;
          for (const name of ["field", "index", "subfield", "alternativeIndex", "start", "end", "totalCharacters"]) {
            if (Object.hasOwn(excerpt, name)) assert.ok(section.includes(`${location}.${name}: ${JSON.stringify(excerpt[name])}`));
          }
          assert.ok(section.includes(`${location}.text (original text):`));
          assert.ok(section.includes(excerpt.text));
        }
      }
    }
  }
  assert.equal(text.includes(`\nNode[${value.nodes.length}]:\n`), false);
}
function fixture(t) {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(parent, "head-graph-work-context-")));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const owner = inspectProject(root), layout = owner.storage;
  const session = createHeadSession({ root, purpose: "Synthetic graph investigation; no external effects" });
  t.after(() => {
    assert.equal(path.dirname(base), fs.realpathSync(parent));
    assert.ok(path.basename(base).startsWith("head-graph-work-context-"));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, session, owner, storage: layout, layout,
    save: (input, sessionId = session.sessionId) => withSessionRoute(root, sessionId, () => recordSessionWorkEvidence({ root, input })),
    read: options => withSessionRoute(root, session.sessionId, () => readSessionWorkContext({ root, ...options })),
  };
}
async function call(name, arguments_, routed = false, options = {}) {
  const response = await dispatch({ jsonrpc: "2.0", id: "graph-work-consumer", method: "tools/call", params: {
    name: routed ? "head_tools_read" : name,
    arguments: routed ? { name, arguments: arguments_ } : arguments_,
  } }, options);
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.notEqual(response.result?.isError, true, JSON.stringify(response));
  return response.result;
}
async function withoutGraphWrites(action) {
  const restore = [], attempts = [];
  const block = (object, name, asynchronous = false) => {
    const original = object[name];
    if (typeof original !== "function") return;
    restore.push(() => { object[name] = original; });
    const rejected = () => { attempts.push(name); assert.fail(`Read-only graph attempted ${name}`); };
    object[name] = asynchronous ? async () => rejected() : rejected;
  };
  const writable = flags => typeof flags === "number"
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/u.test(flags || "");
  const guardOpen = (object, name) => {
    const original = object[name]; restore.push(() => { object[name] = original; });
    object[name] = (file, flags, ...args) => {
      if (writable(flags)) { attempts.push(name); assert.fail("Read-only graph attempted writable open"); }
      return original.call(object, file, flags, ...args);
    };
  };
  for (const name of ["writeFileSync", "appendFileSync", "writeSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "truncateSync", "ftruncateSync", "chmodSync", "fchmodSync", "utimesSync", "linkSync", "symlinkSync", "createWriteStream"]) block(fs, name);
  for (const name of ["writeFile", "appendFile", "write", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "ftruncate", "chmod", "fchmod", "utimes", "link", "symlink"]) block(fs, name);
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "link", "symlink"]) block(fs.promises, name, true);
  guardOpen(fs, "openSync"); guardOpen(fs, "open"); guardOpen(fs.promises, "open");
  try { return await action(); }
  finally { for (const undo of restore.reverse()) undo(); assert.deepEqual(attempts, [], "Caught writes still violate graph read-only behavior"); }
}
async function graphResponse(args, routed, binding) {
  const result = await call("head_project_graph", args, routed, { resolveSessionContext() {
    binding.calls++; throw new Error("Project graph must not ask for native binding");
  } });
  assertGraphPresentation(result.content[0].text, result.structuredContent);
  return result.structuredContent;
}
const originalPath = (f, saved) => path.relative(f.root, saved.file).replaceAll("\\", "/");
function scopedWorkResult(value, f, saved, referencePath) {
  const node = completeNode(value, saved);
  assert.equal(value.reuse.status, "scoped-originals-reused"); assert.equal(value.reuse.wholeProjectCurrent, false);
  assert.deepEqual(value.integrity.verifiedLayers, []);
  assert.ok(value.integrity.verifiedRecordPaths.includes(originalPath(f, saved)));
  assert.ok(value.integrity.verifiedRecordPaths.includes(referencePath));
  assert.equal(new Set(value.integrity.verifiedRecordPaths).size, value.integrity.verifiedRecordPaths.length);
  assert.ok(value.integrity.verifiedRecordPaths.length <= 256);
  assert.equal(value.integrity.verifiedRecordCount, value.integrity.verifiedRecordPaths.length + value.integrity.omittedVerifiedRecordPathCount);
  assert.match(value.basis.proofDigest, /^[a-f0-9]{64}$/u);
  assert.match(value.basis.recordsDigestScope, /retained/iu);
  assert.equal(value.coverage.membership, "current-names-and-types");
  assert.equal(value.coverage.unrelatedRecordBytesReverified, false);
  assert.ok(value.coverage.layers.every(layer => layer.status === "retained-discovery-basis"));
  assert.match(value.sourceFallback.action, /retained/iu);
  assert.match(value.sourceFallback.action, /exclu/iu);
  assert.match(value.sourceFallback.action, /historical|not a fresh/iu);
  return node;
}
function completeNode(value, saved) {
  const node = workNodes(value).find(item => item.nodeId === saved.evidence.evidenceId);
  assert.ok(node, `Missing work original ${saved.evidence.evidenceId}`);
  assert.equal(node.sessionId, saved.evidence.sessionId);
  assert.equal(node.evidenceDigest, saved.evidence.evidenceDigest);
  assert.equal(node.sourceReference.digest, sha(fs.readFileSync(saved.file)));
  assert.deepEqual(node.workContent, saved.evidence.content);
  assert.equal(node.workContentCoverage.partial, false);
  fieldCoverage(node, saved.evidence.content);
  assert.notEqual(node.contentPartial, true, "A complete work body must not be an omitted generic excerpt");
  for (const key of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(node[key], false);
  return node;
}
function expansion(node, f, saved) {
  assert.equal(node.originalExpansion.tool, publicToolName("head_session_work_read"));
  const args = node.originalExpansion.arguments;
  assert.equal(args.project_root, f.root);
  assert.equal(args.session_id, saved.evidence.sessionId);
  assert.deepEqual(args.evidence_ids, [saved.evidence.evidenceId]);
  assert.equal(args.max_records, 1);
  assert.ok(Number.isSafeInteger(args.max_characters) && args.max_characters >= 2 && args.max_characters <= 524288);
  return args;
}
function exactResult(value, saved, args) {
  assert.equal(value.records.length, 1, "A callable expansion must return its original, not a budget-only omission");
  assert.equal(value.omissions.byBudget, 0);
  assert.equal(value.records[0].evidenceId, saved.evidence.evidenceId);
  assert.equal(value.records[0].sessionId, saved.evidence.sessionId);
  assert.equal(value.records[0].evidenceDigest, saved.evidence.evidenceDigest);
  assert.deepEqual(value.records[0].content, saved.evidence.content);
  assert.equal(args.max_characters, JSON.stringify(value.records).length);
}
function semanticCharacters(content) {
  const fields = [content.summary, ...(content.judgments || []).flatMap(item => [item.assessment, item.reason, ...item.alternatives]),
    ...["observedWork", "pending", "unknowns", "suggestedFollowUp", "workTopics"].flatMap(field => content[field] || []),
    ...(content.todos || []).flatMap(todo => ["task", "status", "origin", "nextAction", "reason", "progress", "priority"].map(key => todo[key]))];
  return fields.reduce((total, value) => total + (typeof value === "string" ? value.length : 0), 0);
}
function originalExcerpts(node, original) {
  const content = original.evidence.content, coverage = node.workContentCoverage;
  fieldCoverage(node, content);
  assert.equal(coverage.totalCharacters, semanticCharacters(content));
  assert.equal(coverage.totalCharacters, coverage.includedCharacters + coverage.omittedCharacters);
  assert.equal(coverage.partial, coverage.omittedCharacters > 0);
  for (const [field, value] of Object.entries(node.workContent || {})) {
    assert.ok(Object.hasOwn(content, field), `Unexpected projected work field: ${field}`);
    if (Array.isArray(value)) {
      for (const item of value) assert.ok(content[field].some(source => isDeepStrictEqual(source, item)), `Incomplete item presented as original ${field}`);
    } else assert.deepEqual(value, content[field], `Truncated value presented as complete ${field}`);
  }
  for (const excerpt of node.workContentExcerpts || []) {
    let source;
    if (excerpt.field === "judgments") {
      assert.ok(Number.isSafeInteger(excerpt.index) && excerpt.index >= 0 && excerpt.index < content.judgments.length);
      assert.ok(["assessment", "reason", "alternatives"].includes(excerpt.subfield));
      const judgment = content.judgments[excerpt.index];
      if (excerpt.subfield === "alternatives") {
        assert.ok(Number.isSafeInteger(excerpt.alternativeIndex) && excerpt.alternativeIndex >= 0 && excerpt.alternativeIndex < judgment.alternatives.length);
        source = judgment.alternatives[excerpt.alternativeIndex];
      } else source = judgment[excerpt.subfield];
    } else if (excerpt.field === "todos") {
      const todo = content.todos[excerpt.index];
      assert.equal(excerpt.todoId, todo.todoId); assert.equal(excerpt.status, todo.status); assert.equal(excerpt.origin, todo.origin);
      for (const key of ["prior", "resolves", "relatedEvidence"]) assert.deepEqual(excerpt[key], todo[key]);
      source = todo[excerpt.subfield];
    } else {
      assert.equal(excerpt.subfield, null);
      if (Array.isArray(content[excerpt.field])) {
        assert.ok(Number.isSafeInteger(excerpt.index) && excerpt.index >= 0 && excerpt.index < content[excerpt.field].length);
        source = content[excerpt.field][excerpt.index];
      } else { assert.equal(excerpt.index, null); source = content[excerpt.field]; }
    }
    assert.equal(typeof source, "string");
    assert.ok(Number.isSafeInteger(excerpt.start) && Number.isSafeInteger(excerpt.end) && excerpt.start >= 0 && excerpt.end > excerpt.start && excerpt.end <= source.length);
    assert.equal(excerpt.totalCharacters, source.length);
    assert.equal(excerpt.text, source.slice(excerpt.start, excerpt.end));
  }
}

function fieldCoverage(node, original) {
  assert.equal(node.workContentCoverage.rangeSource, "workContentExcerpts");
  for (const field of ["summary", "judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp", ...(Object.hasOwn(original, "workTopics") ? ["workTopics"] : []), ...(original.todos ? ["todos"] : [])]) {
    const originalItems = field === "summary" ? Number(typeof original.summary === "string") : original[field].length;
    const completeItems = field === "summary" ? Number(typeof node.workContent.summary === "string") : (node.workContent[field] || []).length;
    const partialItems = new Set((node.workContentExcerpts || []).filter(e => e.field === field).map(e => e.index)).size;
    const counts = node.workContentCoverage.fieldItems[field];
    assert.deepEqual(counts, { originalItems, completeItems, partialItems, omittedItems: originalItems - completeItems - partialItems });
    assert.ok(counts.omittedItems >= 0);
    if (!node.contentPartial) assert.equal(counts.completeItems, originalItems);
  }
}

test("A-D: Todo-only semantic terms reach actual graph, CLI/MCP and exact owner expansion without writes", async t => {
  const f = fixture(t), todo = { todoId: "todo-discovery", task: "OnlyTodoTaskXvqn3821", status: "partial", origin: "head-proposed",
    nextAction: "OnlyTodoNextZvjk9482", reason: "OnlyTodoReasonQcma1772", progress: "One bounded part", priority: "Recorded priority unchanged" };
  const saved = f.save({ todos: [todo] }), sibling = createHeadSession({ root: f.root, purpose: "Other owner" });
  const other = f.save({ todos: [todo] }, sibling.sessionId), foreign = fixture(t), foreignSaved = foreign.save({ todos: [todo] });
  const before = snapshot(f.base), foreignBefore = snapshot(foreign.base);
  await withoutGraphWrites(async () => {
    for (const query of [todo.task, todo.nextAction, todo.reason]) {
      const graph = await queryProjectGraph({ root: f.root, query, depth: 0 });
      for (const item of [saved, other]) completeNode(graph, item);
      assert.equal(workNodes(graph).some(node => node.nodeId === foreignSaved.evidence.evidenceId), false);
    }
    const foreignGraph = await queryProjectGraph({ root: foreign.root, query: todo.task, depth: 0 });
    completeNode(foreignGraph, foreignSaved); assert.equal(workNodes(foreignGraph).length, 1);
    const cli = await runCommand(["graph-query", f.root, "--query", todo.task, "--depth", "0"]);
    assertGraphPresentation(formatCliResult("graph-query", cli), cli);
    for (const routed of [false, true]) {
      const result = await call("head_project_graph", { project_root: f.root, query: todo.nextAction, depth: 0 }, routed);
      assertGraphPresentation(result.content[0].text, result.structuredContent);
      for (const item of [saved, other]) {
        const node = completeNode(result.structuredContent, item), args = expansion(node, f, item);
        exactResult((await call("head_session_work_read", args, routed)).structuredContent, item, args);
      }
      const wrongOwner = await call("head_session_work_read", { project_root: f.root, session_id: sibling.sessionId,
        evidence_ids: [saved.evidence.evidenceId], max_records: 1 }, routed);
      assert.deepEqual(wrongOwner.structuredContent.records, []); assert.equal(wrongOwner.structuredContent.ordinaryWorkBlocked, false);
    }
  });
  assert.deepEqual(snapshot(f.base), before);
  assert.deepEqual(snapshot(foreign.base), foreignBefore);
});

test("A-D: two long Todo revisions retain sparse source indices, status, provenance, ranges and omission coverage", async t => {
  const f = fixture(t), seed = "SparseTodoOnlyMvnq6721", base = f.save({ todos: [{ todoId: "todo-sparse", task: "Earlier work", status: "pending", origin: "user-directed", nextAction: "Inspect" }] });
  const prior = { evidenceId: base.evidence.evidenceId, evidenceDigest: base.evidence.evidenceDigest }, saved = [];
  for (const status of ["partial", "cancelled"]) saved.push(f.save({ todos: [
    { todoId: "todo-large", task: "a".repeat(14000), reason: "b".repeat(14000), status: "pending", origin: "head-proposed", nextAction: "Inspect first" },
    { todoId: "todo-small-one", task: "Separate first", status: "completed", origin: "user-directed" },
    { todoId: "todo-small-two", task: "Separate second", status: "pending", origin: "head-proposed", nextAction: "Continue independently" },
    { todoId: "todo-sparse", task: "t".repeat(8000), status, origin: "user-directed", nextAction: "n".repeat(3000), reason: seed + " " + "r".repeat(8000),
      progress: "Recorded partial outcome", priority: "No inferred score", prior },
  ] }));
  const before = snapshot(f.base);
  await withoutGraphWrites(async () => {
    const graph = await queryProjectGraph({ root: f.root, query: seed, depth: 0, maxEdges: 0 });
    assert.equal(workNodes(graph).length, 2);
    assert.ok(workNodes(graph).reduce((n, node) => n + JSON.stringify({ workContent: node.workContent, workContentExcerpts: node.workContentExcerpts }).length, 0) <= 32768);
    for (const node of workNodes(graph)) {
      const item = saved.find(item => item.evidence.evidenceId === node.nodeId);
      originalExcerpts(node, item); assert.equal(node.contentPartial, true);
      assert.deepEqual(node.workContent.todos, [], "Partial Todos stay exact indexed excerpts, never a compacted alias");
      const sparse = node.workContentExcerpts.filter(entry => entry.field === "todos" && entry.index === 3);
      assert.ok(sparse.some(entry => entry.subfield === "reason" && entry.text.includes(seed)));
      assert.ok(sparse.every(entry => entry.todoId === "todo-sparse" && entry.origin === "user-directed"));
      assert.equal(node.workContentCoverage.fieldItems.todos.originalItems, 4);
      assert.ok(node.workContentCoverage.fieldItems.todos.omittedItems > 0);
      const args = expansion(node, f, item);
      exactResult((await call("head_session_work_read", args)).structuredContent, item, args);
    }
    assertGraphPresentation(formatCliResult("graph-query", graph), graph);
    const cli = await runCommand(["graph-query", f.root, "--query", seed, "--depth", "0", "--max-edges", "0"]);
    assertGraphPresentation(formatCliResult("graph-query", cli), cli);
    for (const routed of [false, true]) {
      const result = await call("head_project_graph", { project_root: f.root, query: seed, depth: 0, max_edges: 0 }, routed);
      assertGraphPresentation(result.content[0].text, result.structuredContent);
      for (const node of workNodes(result.structuredContent)) originalExcerpts(node, saved.find(item => item.evidence.evidenceId === node.nodeId));
    }
    // A bounded real query projection enters the shipped DOM component here.
    // This is a component-input check, not an export or actual-browser proof.
    const snapshot = await buildGraphExplorerSnapshot({ root: f.root, query: seed });
    const bounded = new Map(workNodes(graph).map(node => [node.nodeId, node]));
    const ui = explorerDom({ ...snapshot, graph: { ...snapshot.graph,
      nodes: snapshot.graph.nodes.map(node => bounded.has(node.nodeId) ? { ...node, ...bounded.get(node.nodeId) } : node) } }); await ui.settle();
    for (const node of workNodes(graph)) {
      const read = ui.ids.get("records").children.flatMap(row => row.children).find(element => element.getAttribute("data-record-entry") === node.nodeId);
      assert.ok(read); ui.event(read); await ui.settle();
      const card = ui.ids.get("selection-cards").children.find(card => card.getAttribute("data-record")?.includes(node.nodeId));
      assert.ok(card);
      for (const value of ["workContent.todos[3].reason", "todo-sparse", "user-directed", "Partial exported content", "unknown"]) assert.ok(card.textContent.includes(value));
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("A-D: actual snapshot and HTML export render Todo-only task, cancellation and reason in synthetic DOM cards", async t => {
  const f = fixture(t), saved = f.save({ todos: [{ todoId: "todo-display", task: "ReadableTodoOnlyGvhx7712", status: "cancelled", origin: "head-proposed",
    reason: "Cancelled because current scope changed", progress: "A partial attempt", priority: "Preserve original priority" }] });
  const before = snapshot(f.root), data = await withoutGraphWrites(async () => (await buildGraphExplorerSnapshot({ root: f.root, anchorIds: [saved.evidence.evidenceId] })));
  const ui = explorerDom(data); await ui.settle();
  const rows = ui.ids.get("records").children, row = rows.find(row => row.textContent.includes("ReadableTodoOnlyGvhx7712"));
  assert.ok(row); ui.event(row.children[0]); await ui.settle();
  const card = ui.ids.get("selection-cards").children.find(card => card.textContent.includes("todo-display"));
  assert.ok(card, "Actual snapshot must expose Todo text through shipped card scripts");
  for (const value of ["ReadableTodoOnlyGvhx7712", "cancelled", "head-proposed", "Cancelled because current scope changed", "Preserve original priority"]) assert.ok(card.textContent.includes(value));
  assert.ok(card.textContent.includes("unknown"));
  const output = path.join(f.base, "todo-view.html"), exported = await exportGraphExplorer({ root: f.root, anchorIds: [saved.evidence.evidenceId], output });
  assert.equal(exported.file, output);
  for (const value of ["ReadableTodoOnlyGvhx7712", saved.evidence.evidenceId, "Recorded Todo revisions"]) assert.ok(fs.readFileSync(output, "utf8").includes(value));
  assert.deepEqual(snapshot(f.root), before);
  t.diagnostic("Real local graph/snapshot/export and shipped scripts in synthetic DOM; not actual GUI or model proof.");
});

test("public saved semantic fields are discoverable in fitting short, detail, path, anchor and owner-neighbor results", async t => {
  const f = fixture(t), saved = f.save({ summary: "A plain progress note", judgments: [{
    assessment: "AssessmentNeedle", reason: "Earlier context. ".repeat(40) + "ReasonNeedle preserves the original tradeoff", alternatives: ["AlternativeNeedle"] }],
    observedWork: ["ObservationNeedle"], pending: ["PendingNeedle"], unknowns: ["UnknownNeedle"], suggestedFollowUp: ["FollowUpNeedle"] });
  const before = snapshot(f.base);
  for (const query of ["AssessmentNeedle", "ReasonNeedle", "AlternativeNeedle", "ObservationNeedle", "PendingNeedle", "UnknownNeedle", "FollowUpNeedle"]) {
    completeNode(await queryProjectGraph({ root: f.root, query, depth: 0 }), saved);
  }
  const relative = path.relative(f.root, saved.file).replaceAll("\\", "/");
  for (const options of [{ paths: [relative], depth: 0 }, { anchorIds: [saved.evidence.evidenceId], depth: 0 },
    { anchorIds: [saved.evidence.evidenceId], depth: 0, details: true }, { anchorIds: [f.session.sessionId], depth: 1, maxNodes: 20, maxEdges: 30 }]) {
    const value = await queryProjectGraph({ root: f.root, ...options });
    expansion(completeNode(value, saved), f, saved);
  }
  const related = await queryProjectGraph({ root: f.root, anchorIds: [saved.evidence.evidenceId], depth: 1 });
  assert.ok(related.edges.some(edge => edge.type === "RECORDED_FOR_SESSION" && edge.from === saved.evidence.evidenceId && edge.to === f.session.sessionId));
  assert.deepEqual(snapshot(f.base), before);
});

test("Core topic-only lexical discovery carries the actual reason/result/pending through graph routes and CLI/MCP", async t => {
  const f = fixture(t), topic = "TopicOnlyQzvm7431";
  const saved = f.save({ workTopics: [topic], summary: "Retained implementation choice",
    judgments: [{ assessment: "Keep the narrow change", reason: "Earlier reason: broad replacement loses provenance", alternatives: ["Rejected full replacement"] }],
    observedWork: ["Actual result: local fixture produced the expected bytes"], pending: ["Remaining validation is separate"], unknowns: ["Native outcome is unknown"] });
  const unlabeled = f.save({ summary: "UnlabeledBodyQpwn8642 remains discoverable", pending: ["Ordinary work remains usable"] });
  const { workTopics, ...otherContent } = saved.evidence.content;
  assert.deepEqual(workTopics, [topic]);
  assert.equal(JSON.stringify(otherContent).includes(topic), false, "The topic witness must not also occur in a searchable body");
  assert.equal(saved.file.includes(topic), false, "The topic witness must not be supplied by its source path");
  // initializeProject retains an empty compatibility seed; file presence does
  // not mean Product governance or any authoritative Feature was activated.
  const productSeed = JSON.parse(fs.readFileSync(path.join(f.root, f.layout.directory, "context/product-model.json"), "utf8"));
  for (const field of ["featureGroups", "capabilities", "features", "requirements", "constraints", "decisions"]) assert.deepEqual(productSeed[field], []);
  const experience = (await inspectProjectExperience({ root: f.root }));
  assert.equal(experience.readiness.product.governanceActivated, false, "Core topic discovery must not activate Product governance");
  assert.equal(experience.readiness.context.worldModelId, null, "Core topic discovery must not require a World model");
  const before = snapshot(f.base), relative = originalPath(f, saved);
  await withoutGraphWrites(async () => {
    for (const options of [{ query: topic, depth: 0 }, { query: topic, depth: 0, details: true },
      { paths: [relative], depth: 0 }, { anchorIds: [saved.evidence.evidenceId], depth: 0 },
      { anchorIds: [f.session.sessionId], depth: 1, maxNodes: 20, maxEdges: 30 }]) {
      const value = await queryProjectGraph({ root: f.root, ...options });
      completeNode(value, saved);
      assert.equal(value.edges.some(edge => ["IMPLEMENTS", "VERIFIED_BY"].includes(edge.type)), false);
      assertGraphPresentation(formatCliResult("graph-query", value), value);
    }
    completeNode(await queryProjectGraph({ root: f.root, query: "UnlabeledBodyQpwn8642", depth: 0 }), unlabeled);
    const cli = await runCommand(["graph-query", f.root, "--query", topic, "--depth", "0"]);
    completeNode(cli, saved); assertGraphPresentation(formatCliResult("graph-query", cli), cli);
    for (const routed of [false, true]) {
      const result = await call("head_project_graph", { project_root: f.root, query: topic, depth: 0 }, routed);
      completeNode(result.structuredContent, saved); assertGraphPresentation(result.content[0].text, result.structuredContent);
      exactResult((await call("head_session_work_read", expansion(completeNode(result.structuredContent, saved), f, saved), routed)).structuredContent,
        saved, expansion(completeNode(result.structuredContent, saved), f, saved));
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("same topic keeps two Session owners, two declared roots, standalone work and multi-label bodies distinct", async t => {
  const f = fixture(t), other = createHeadSession({ root: f.root, purpose: "Independent topic owner" }), topic = "SharedTopicZrjx9924";
  const a = f.save({ workTopics: [topic], summary: "First root body marker Fmuv0111" });
  const b = f.save({ workTopics: [topic], summary: "Second root body marker Lprx0222" });
  const rootLink = root => ({ root: { evidenceId: root.evidence.evidenceId, evidenceDigest: root.evidence.evidenceDigest },
    predecessor: { evidenceId: root.evidence.evidenceId, evidenceDigest: root.evidence.evidenceDigest } });
  const linkedA = f.save({ workTopics: [topic, "SecondaryTopicGfks7755"], workLink: rootLink(a), summary: "First contribution body marker Tvwk0333",
    judgments: [{ assessment: "Identical choice", reason: "Identical retained reason", alternatives: [] }], pending: ["First root remaining item"] });
  const linkedB = f.save({ workTopics: [topic], workLink: rootLink(b), summary: "Second contribution body marker Wgqm0444",
    judgments: [{ assessment: "Identical choice", reason: "Identical retained reason", alternatives: [] }], pending: ["Second root remaining item"] });
  const standalone = f.save({ workTopics: [topic], summary: "Unlinked body marker Clzd0555" });
  const independent = f.save({ workTopics: [topic], summary: "Other owner body marker Rbnv0666" }, other.sessionId);
  const saved = [a, b, linkedA, linkedB, standalone, independent], before = snapshot(f.base);
  await withoutGraphWrites(async () => {
    const value = await queryProjectGraph({ root: f.root, query: topic, depth: 0, maxNodes: 20 });
    assert.equal(workNodes(value).length, saved.length);
    assert.equal(new Set(workNodes(value).map(node => node.nodeId)).size, saved.length);
    const text = formatCliResult("graph-query", value);
    for (const original of saved) {
      completeNode(value, original);
      assert.equal(text.split(original.evidence.content.summary).length - 1, 1, "Each actual body is rendered once across topic associations");
    }
    const { sessions } = assertTerminalGraphPresentation(text, value);
    assert.notEqual(sessions.get(f.session.sessionId), sessions.get(other.sessionId));
    const diagnostics = formatCliResult("graph-query", value, { diagnostics: true, columns: 240 });
    for (const id of [f.session.sessionId, other.sessionId, a.evidence.evidenceId, b.evidence.evidenceId]) assert.ok(diagnostics.includes(id));
    assert.ok(text.includes("SecondaryTopicGfks7755"));
    assert.deepEqual(completeNode(value, standalone).workContent.workLink, undefined);
    for (const session of [f.session, other]) {
      const read = withSessionRoute(f.root, session.sessionId, () => readSessionWorkContext({ root: f.root, maxRecords: 20 }));
      assert.ok(read.records.length > 0);
      assert.ok(read.records.every(record => record.sessionId === session.sessionId), "Topic associations cannot import a different Session's work");
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("real graph basis ownership groups nested roots in CLI and direct/router MCP without duplicating bodies or losing returned endpoints", async t => {
  const f = fixture(t), other = createHeadSession({ root: f.root, purpose: "Independent nested-root owner" }), topic = "GraphBasisOwnerZmvp4927";
  const exact = saved => ({ evidenceId: saved.evidence.evidenceId, evidenceDigest: saved.evidence.evidenceDigest });
  const linked = root => ({ root: exact(root), predecessor: exact(root) });
  const a0 = f.save({ workTopics: [topic], summary: "Basis owner root marker Qjts1011" });
  const a1 = f.save({ workTopics: [topic, "Secondary nested association"], workLink: linked(a0), summary: "Basis owner first contribution marker Rmvd2022" });
  const a2 = f.save({ workTopics: [topic], workLink: linked(a0), summary: "Basis owner second contribution marker Gknw3033" });
  const nested = f.save({ workTopics: [topic], workLink: linked(a1), summary: "Basis owner nested contribution marker Czlr4044" });
  const independent = f.save({ workTopics: [topic], summary: "Basis owner independent root marker Phxb5055" });
  const otherOwner = f.save({ workTopics: [topic], summary: "Basis owner other Session marker Ftqg6066" }, other.sessionId);
  const saved = [a0, a1, a2, nested, independent, otherOwner], before = snapshot(f.base);
  const expectedGroups = new Map([
    [a0.evidence.evidenceId, [a0, a1, a2]], [a1.evidence.evidenceId, [nested]],
    [independent.evidence.evidenceId, [independent]], [otherOwner.evidence.evidenceId, [otherOwner]],
  ]);
  const check = (value, text) => {
    assert.equal(Object.hasOwn(value, "projectId"), false, "Use the real graph envelope, whose owner is in basis");
    assert.equal(value.basis.projectId, a0.evidence.projectId);
    assert.equal(workNodes(value).length, saved.length);
    assert.ok(workNodes(value).every(node => !Object.hasOwn(node, "projectId")), "Do not inject owner fields into actual graph work nodes");
    assertGraphPresentation(text, value);
    if (text.startsWith("Selected connections:")) {
      const { sessions } = assertTerminalGraphPresentation(text, value);
      const headings = [...text.matchAll(/^Work group G(\d+): (S\d+); (declared|standalone) root \[(\d+)\]\n  Members: ([^\n]+); bodies appear once below\./gmu)];
      assert.equal(headings.length, expectedGroups.size, "All exact owner/root groups remain visible");
      const seen = new Set();
      for (const heading of headings) {
        const rootNode = value.nodes[Number(heading[4]) - 1], members = expectedGroups.get(rootNode.nodeId);
        assert.ok(members); assert(!seen.has(rootNode.nodeId)); seen.add(rootNode.nodeId);
        assert.equal(rootNode.evidenceDigest, exact(rootNode.nodeId === a1.evidence.evidenceId ? a1 : members[0]).evidenceDigest);
        assert.equal(heading[2], sessions.get(members[0].evidence.sessionId));
        const displayedIds = [...heading[5].matchAll(/\[(\d+)\]/gu)].map(match => value.nodes[Number(match[1]) - 1].nodeId);
        assert.deepEqual(new Set(displayedIds), new Set(members.map(member => member.evidence.evidenceId)));
      }
      for (const original of saved) {
        completeNode(value, original);
        assert.equal(text.split(original.evidence.content.summary).length - 1, 1, "Grouping references never repeat actual bodies");
      }
      return;
    }
    const headings = [...text.matchAll(/^Session work group \((.+)\):\nDeclared historical work root: (.+)\n/gmu)];
    assert.equal(headings.length, expectedGroups.size, "Six actual bodies form four exact owner/root groups");
    const seenRoots = new Set();
    for (const [index, heading] of headings.entries()) {
      const sessionId = JSON.parse(heading[1]), root = JSON.parse(heading[2].slice(heading[2].indexOf("{")));
      const members = expectedGroups.get(root.evidenceId);
      assert.ok(members, "No root may be inferred, transitively collapsed or split through absent graph owner context");
      assert.equal(seenRoots.has(root.evidenceId), false); seenRoots.add(root.evidenceId);
      assert.deepEqual(root, exact(root.evidenceId === a1.evidence.evidenceId ? a1 : members[0]));
      assert.equal(sessionId, members[0].evidence.sessionId);
      const section = text.slice(heading.index + heading[0].length, headings[index + 1]?.index);
      const displayedIds = [...section.matchAll(/^Node\[(\d+)\]:\n/gmu)].map(match => value.nodes[Number(match[1])].nodeId);
      assert.deepEqual(new Set(displayedIds), new Set(members.map(member => member.evidence.evidenceId)));
      if (root.evidenceId === a1.evidence.evidenceId) {
        const originalIndex = value.nodes.findIndex(node => node.nodeId === a1.evidence.evidenceId);
        assert.ok(section.includes(`Root body: Node[${originalIndex}], displayed in its own declared group, not repeated.`),
          "The nested root points to its actual original node index without moving or repeating its body");
      }
    }
    assert.equal(text.includes("Root body not in returned selection"), false, "Every declared endpoint was actually returned");
    for (const original of saved) {
      completeNode(value, original);
      assert.equal(text.split(original.evidence.content.summary).length - 1, 1, "Each full body is rendered once across root/topic associations");
    }
  };
  await withoutGraphWrites(async () => {
    const value = await queryProjectGraph({ root: f.root, query: topic, depth: 0, maxNodes: 20 });
    check(value, formatCliResult("graph-query", value));
    const cli = await runCommand(["graph-query", f.root, "--query", topic, "--depth", "0", "--max-nodes", "20"]);
    check(cli, formatCliResult("graph-query", cli));
    for (const routed of [false, true]) {
      const result = await call("head_project_graph", { project_root: f.root, query: topic, depth: 0, max_nodes: 20 }, routed);
      check(result.structuredContent, result.content[0].text);
    }
  });
  assert.deepEqual(snapshot(f.base), before);
});

test("partial graph topic bodies use exact source-index ranges and count topics without displacing reason/pending/unknown", async t => {
  const f = fixture(t), topic = "PartialTopicFhzk3382", saved = [];
  for (let index = 0; index < 2; index++) saved.push(f.save({ summary: `Bounded topic projection ${index}`,
    workTopics: ["Small independent navigation label", topic + " ".repeat(index + 1) + '"\\'.repeat(11000)],
    judgments: [{ assessment: "Preserve the choice", reason: "Original reason remains useful", alternatives: ["Rejected broad replacement"] }],
    pending: ["Remaining local verification"], unknowns: ["External outcome remains unknown"] }));
  const before = snapshot(f.base);
  const result = await withoutGraphWrites(async () => (await queryProjectGraph({ root: f.root, query: topic, depth: 0, maxEdges: 0 })));
  assert.equal(workNodes(result).length, 2);
  assert.ok(workNodes(result).some(node => node.contentPartial));
  assert.ok(workNodes(result).reduce((sum, node) => sum + JSON.stringify({ workContent: node.workContent, workContentExcerpts: node.workContentExcerpts }).length, 0) <= 32768);
  for (const node of workNodes(result)) {
    const original = saved.find(item => item.evidence.evidenceId === node.nodeId);
    originalExcerpts(node, original);
    assert.ok(node.workContent.judgments.some(item => item.reason.length) || node.workContentExcerpts.some(item => item.subfield === "reason"));
    for (const field of ["pending", "unknowns"]) assert.ok(node.workContent[field]?.length || node.workContentExcerpts.some(item => item.field === field));
    assert.equal((node.workContent.workTopics || []).length, 0, "Partial topic projections must not lose source indices in a compacted whole-topic array");
    const topicRanges = node.workContentExcerpts.filter(item => item.field === "workTopics");
    assert.ok(topicRanges.some(item => item.index === 1 && item.text.includes(topic)), "The query match needs an actual original topic range");
    assert.ok(topicRanges.some(item => item.index === 0 && item.start === 0 && item.end === original.evidence.content.workTopics[0].length),
      "Even a whole topic retains its original index when its surrounding body is partial");
    assertGraphPresentation(formatCliResult("graph-query", result), result);
    const args = expansion(node, f, original);
    exactResult((await call("head_session_work_read", args)).structuredContent, original, args);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("same-name topic cannot create or retarget reviewed Product edges and changed/missing source keeps historical reasoning", async t => {
  const f = fixture(t), topic = "Delivery navigation";
  fs.writeFileSync(path.join(f.root, f.layout.directory, "context/product-model.json"), JSON.stringify({ schemaVersion: 1,
    featureGroups: [{ key: "delivery", name: "Delivery", description: "Synthetic fixture" }],
    capabilities: [{ key: "delivery", name: topic, description: "Deliver a value" }],
    features: [{ key: "delivery", name: topic, description: "Synthetic source-backed feature", featureGroupKeys: ["delivery"], capabilityKeys: ["delivery"], governedBy: [] }],
    requirements: [], constraints: [], decisions: [] }));
  fs.mkdirSync(path.join(f.root, "src")); fs.mkdirSync(path.join(f.root, "test"));
  const sourcePath = "src/delivery.mjs", testPath = "test/delivery.test.mjs", source = "export function deliver(value) { return value; }\n";
  fs.writeFileSync(path.join(f.root, sourcePath), source); fs.writeFileSync(path.join(f.root, testPath), "export function verifiesDelivery() { return true; }\n");
  await startFeatureMapping({ root: f.root });
  const world = (await inspectWorldModel({ root: f.root })), graph = world.snapshot.temporalProvenanceGraph;
  const product = graph.nodes.find(node => node.kind === "Feature" && node.key === "delivery");
  const candidates = [["IMPLEMENTS", "File", sourcePath], ["VERIFIED_BY", "Test", testPath]].map(([relationshipType, kind, file]) => ({
    relationshipType, sourceNodeId: graph.nodes.find(node => node.kind === kind && node.path === file).nodeId, productNodeId: product.nodeId,
    explanation: "Synthetic explicit reviewed exact relationship", confidence: 0.9 }));
  const proposed = await startFeatureMapping({ root: f.root, semanticProposal: { schemaVersion: 1, sourceSnapshotId: graph.sourceSnapshotId,
    productModelId: world.snapshot.productModel.productModelId, candidates } });
  await reviewFeatureMapping({ root: f.root, candidateSetId: proposed.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Synthetic fixture accepts exact evidence" });
  const reviewed = (await inspectWorldModel({ root: f.root })).snapshot.temporalProvenanceGraph.edges.filter(edge => ["IMPLEMENTS", "VERIFIED_BY"].includes(edge.type));
  assert.equal(reviewed.length, 2);
  const saved = f.save({ workTopics: [topic], judgments: [{ assessment: "Retain exact source context", reason: "Historical reasoning survives endpoint changes", alternatives: ["Do not retarget by label"] }],
    pending: ["Current verification still required"], references: [{ path: sourcePath, digest: sha(source), kind: "source" }] });
  const unlinked = f.save({ workTopics: [topic], summary: "Same-name independent contribution" });
  const savedBytes = fs.readFileSync(saved.file);
  for (const state of ["current", "changed", "missing"]) {
    if (state === "changed") fs.writeFileSync(path.join(f.root, sourcePath), "export function renamed(value) { return String(value); }\n");
    if (state === "missing") fs.unlinkSync(path.join(f.root, sourcePath));
    const before = snapshot(f.base);
    const value = await withoutGraphWrites(async () => (await queryProjectGraph({ root: f.root, query: topic, depth: 1, maxNodes: 40, maxEdges: 60 })));
    const node = completeNode(value, saved); completeNode(value, unlinked);
    assert.equal(node.referenceEvidence[0].currentness, state);
    assert.equal(value.edges.some(edge => ["IMPLEMENTS", "VERIFIED_BY"].includes(edge.type)
      && [saved.evidence.evidenceId, unlinked.evidence.evidenceId].includes(edge.from)), false);
    assert.deepEqual((await inspectWorldModel({ root: f.root })).snapshot.temporalProvenanceGraph.edges.filter(edge => ["IMPLEMENTS", "VERIFIED_BY"].includes(edge.type)), reviewed);
    assert.deepEqual(fs.readFileSync(saved.file), savedBytes);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test("CLI and direct/router MCP retain the same work body without requesting native binding or writing", async t => {
  const f = fixture(t), saved = f.save({ judgments: [{ assessment: "Keep original", reason: "SurfaceReasonNeedle", alternatives: ["Rejected alternative"] }], pending: ["X remains"], unknowns: ["Provider unverified"] });
  const before = snapshot(f.base), core = await queryProjectGraph({ root: f.root, query: "SurfaceReasonNeedle", depth: 0 });
  const expected = completeNode(core, saved), cli = await runCommand(["graph-query", f.root, "--query", "SurfaceReasonNeedle", "--depth", "0"]);
  assert.deepEqual(completeNode(cli, saved).workContent, expected.workContent);
  assertGraphPresentation(formatCliResult("graph-query", cli), cli);
  let bindingCalls = 0;
  for (const routed of [false, true]) {
    const result = await call("head_project_graph", { project_root: f.root, query: "SurfaceReasonNeedle", depth: 0 }, routed,
      { resolveSessionContext() { bindingCalls++; throw new Error("Project graph must not require native binding"); } });
    assert.deepEqual(completeNode(result.structuredContent, saved).workContent, expected.workContent);
    assertGraphPresentation(result.content[0].text, result.structuredContent);
  }
  assert.equal(bindingCalls, 0);
  assert.deepEqual(snapshot(f.base), before);
});

test("returned node detail follows direct/router MCP with default120, compact12 and explicit0 scoped keys", async t => {
  const f = fixture(t), selectedReference = "selected-source.txt", sourceBytes = Buffer.from("Small required reference; not execution authority");
  fs.writeFileSync(path.join(f.root, selectedReference), sourceBytes);
  fs.writeFileSync(path.join(f.root, "independent-source.txt"), "i".repeat(16384));
  const anchor = f.save({ summary: "Declared earlier anchor", pending: ["Earlier X remains"] });
  const exactAnchor = { evidenceId: anchor.evidence.evidenceId, evidenceDigest: anchor.evidence.evidenceDigest };
  const saved = f.save({ judgments: [{ assessment: "Preserve the original choice", reason: "ConnectedDetailReasonNeedle ".padEnd(6073, "r"), alternatives: ["Rejected rewrite"] }],
    pending: ["X remains"], unknowns: ["External effect is unknown"],
    references: [{ path: selectedReference, digest: sha(sourceBytes), kind: "source" }],
    workLink: { root: exactAnchor, predecessor: exactAnchor }, executionObservation: { state: "paused", target: exactAnchor } });
  f.save({ summary: "Independent work with an unrelated reference", references: [{ path: "independent-source.txt", digest: sha(fs.readFileSync(path.join(f.root, "independent-source.txt"))), kind: "source" }] });
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Inspect retained graph evidence only", constraints: ["No external effects"], cancelledActions: ["deployment"] } }).direction;
  const before = snapshot(f.base), binding = { calls: 0 };
  await withoutGraphWrites(async () => {
    const broad = await queryProjectGraph({ root: f.root, query: "ConnectedDetailReasonNeedle", depth: 0 });
    const discovered = completeNode(broad, saved), detail = structuredClone(discovered.detail);
    assert.deepEqual(detail.anchorIds, [saved.evidence.evidenceId]); assert.equal(detail.details, true); assert.equal(detail.depth, 0);
    assert.equal(Object.hasOwn(detail, "maxEdges"), false, "Follow the actual returned detail without silently forcing zero edges");
    const keys = new Set();
    for (const mode of [
      { details: detail.details, expectedEdges: 120 },
      { details: false, expectedEdges: 12 },
      { details: detail.details, maxEdges: 0, expectedEdges: 0 },
    ]) {
      const args = { project_root: f.root, anchor_ids: detail.anchorIds, details: mode.details, depth: detail.depth,
        ...(mode.maxEdges !== undefined ? { max_edges: mode.maxEdges } : {}) };
      const first = await graphResponse(args, false, binding);
      assert.equal(first.query.maxEdges, mode.expectedEdges); assert.equal(first.query.details, mode.details);
      assert.equal(first.query.maxNodes, mode.details ? 60 : 8); assert.equal(first.query.depth, detail.depth);
      assert.deepEqual(first.query.anchorIds, detail.anchorIds);
      const original = completeNode(first, saved);
      assert.equal(original.referenceEvidence[0].currentness, "current"); assert.equal(original.referenceEvidence[0].currentDigest, sha(sourceBytes));
      assert.ok(first.boundary.nextAnchorIds.includes(f.session.sessionId), "Depth0 still discloses its incident boundary");
      assert.equal(first.edges.length, 0);
      for (const routed of [false, true]) {
        const warm = await graphResponse(args, routed, binding), node = scopedWorkResult(warm, f, saved, selectedReference);
        assert.equal(warm.query.maxEdges, mode.expectedEdges); assert.equal(warm.query.details, mode.details);
        assert.deepEqual(node.workContent, original.workContent); assert.deepEqual(node.workContentCoverage, original.workContentCoverage);
        assert.deepEqual(node.referenceEvidence, original.referenceEvidence); assert.deepEqual(node.originalExpansion, original.originalExpansion);
        assert.deepEqual(node.sourceReference, original.sourceReference); assert.deepEqual(warm.boundary, first.boundary);
        assert.deepEqual(warm.edges, first.edges); assert.deepEqual(warm.unmatchedAnchorIds, first.unmatchedAnchorIds);
        assert.equal(warm.omittedMatchCount, first.omittedMatchCount);
        assert.deepEqual(node.workContent.pending, ["X remains"]); assert.deepEqual(node.workContent.unknowns, ["External effect is unknown"]);
        keys.add(warm.resultId);
        node.workContent.pending[0] = "Caller mutation must not enter cache";
        warm.boundary.nextAnchorIds.push("caller-supplied-anchor");
        const repeated = await graphResponse(args, routed, binding);
        assert.deepEqual(completeNode(repeated, saved).workContent, original.workContent);
        assert.deepEqual(repeated.boundary, first.boundary);
      }
    }
    assert.equal(keys.size, 3, "Normalized default120/default12/explicit0 queries retain separate identities");
    assert.deepEqual(readProjectDirection({ root: f.root }), direction);
  });
  assert.equal(binding.calls, 0); assert.deepEqual(snapshot(f.base), before);
});

test("partial matched anchors and unsupported detail queries retain conservative proof or cold fallback", async t => {
  const f = fixture(t), selected = f.save({ summary: "ConservativeDetailNeedle one", pending: ["X remains"], unknowns: ["Unknown effect"] });
  const other = f.save({ summary: "ConservativeDetailNeedle two" }), independent = f.save({ summary: "Independent unselected work" });
  const before = snapshot(f.base), binding = { calls: 0 };
  await withoutGraphWrites(async () => {
    const found = await queryProjectGraph({ root: f.root, query: "ConservativeDetailNeedle", depth: 0 });
    const detail = completeNode(found, selected).detail;
    const cases = [
      { label: "partial-matched", args: { anchor_ids: [...detail.anchorIds, other.evidence.evidenceId], details: detail.details, depth: detail.depth, max_nodes: 1 } },
      { label: "unmatched", args: { anchor_ids: [...detail.anchorIds, "work-evidence-" + "f".repeat(24)], details: detail.details, depth: detail.depth } },
      { label: "depth1", args: { anchor_ids: detail.anchorIds, details: detail.details, depth: 1 } },
      { label: "text-query", args: { anchor_ids: detail.anchorIds, details: detail.details, depth: detail.depth, query: "ConservativeDetailNeedle" } },
    ];
    for (const entry of cases) {
      const args = { project_root: f.root, ...entry.args };
      await graphResponse(args, false, binding);
      for (const routed of [false, true]) {
        const value = await graphResponse(args, routed, binding);
        assert.equal(value.query.maxEdges, 120);
        for (const node of workNodes(value)) completeNode(value, [selected, other, independent].find(saved => saved.evidence.evidenceId === node.nodeId));
        if (entry.label === "partial-matched") {
          assert.equal(workNodes(value).length, 1); assert.equal(value.omittedMatchCount, 1);
          assert.deepEqual(value.unmatchedAnchorIds, [], "Matched-but-unreturned is not an unmatched anchor");
        }
        if (entry.label === "unmatched") {
          assert.deepEqual(value.unmatchedAnchorIds, ["work-evidence-" + "f".repeat(24)]);
          assert.notEqual(value.reuse?.status, "scoped-originals-reused", "An unresolved requested anchor cannot prime narrow reuse");
        }
        if (value.reuse?.status === "scoped-originals-reused") {
          for (const saved of [selected, other, independent]) assert.ok(value.integrity.verifiedRecordPaths.includes(originalPath(f, saved)), `${entry.label}: unsupported narrowing must retain the old conservative work proof`);
        }
      }
    }
  });
  assert.equal(binding.calls, 0); assert.deepEqual(snapshot(f.base), before);
});

test("identical text in separate Sessions keeps distinct graph identity and exact expansion ownership", async t => {
  const f = fixture(t), other = createHeadSession({ root: f.root, purpose: "Independent second owner" });
  const direction = updateProjectDirection({ root: f.root, input: { goal: "Inspect retained work only", constraints: ["No external effects"], cancelledActions: ["deploy"] } }).direction;
  const input = { judgments: [{ assessment: "Same", reason: "DistinctOwnerNeedle", alternatives: ["Same alternative"] }] };
  const a = f.save(input), b = f.save(input, other.sessionId), d = f.save(input, inspectProject(f.root).state.sessionId), before = snapshot(f.base);
  assert.notEqual(a.evidence.evidenceId, b.evidence.evidenceId);
  const found = await queryProjectGraph({ root: f.root, query: "DistinctOwnerNeedle", depth: 0 });
  assert.equal(workNodes(found).length, 3);
  assert.equal(new Set(workNodes(found).map(node => node.nodeId)).size, 3);
  for (const saved of [a, b, d]) {
    const args = expansion(completeNode(found, saved), f, saved);
    const result = await call("head_session_work_read", args);
    exactResult(result.structuredContent, saved, args);
  }
  assert.deepEqual(readProjectDirection({ root: f.root }), direction);
  assert.deepEqual(snapshot(f.base), before);
});

test("one near-limit work keeps its full reason in question, path, anchor and neighbor output despite navigation nodes", async t => {
  const f = fixture(t), reason = "LargeSingleReasonNeedle " + "r".repeat(59000), saved = f.save({
    judgments: [{ assessment: "Preserve the exact long reason", reason, alternatives: ["Do not replace it with a generic prefix"] }], pending: ["X"], unknowns: ["External effect unknown"] });
  assert.ok(fs.statSync(saved.file).size > 58000 && fs.statSync(saved.file).size <= 65536);
  const originalDefault = f.read({ evidenceIds: [saved.evidence.evidenceId], maxRecords: 1 });
  assert.equal(originalDefault.records.length, 0); assert.equal(originalDefault.omissions.byBudget, 1);
  const before = snapshot(f.base), relative = path.relative(f.root, saved.file).replaceAll("\\", "/");
  for (const options of [{ query: "LargeSingleReasonNeedle", depth: 1 }, { paths: [relative], depth: 1 },
    { anchorIds: [saved.evidence.evidenceId], depth: 1 }, { anchorIds: [f.session.sessionId], depth: 1, maxNodes: 20, maxEdges: 30 },
    { anchorIds: [saved.evidence.evidenceId], details: true, depth: 1 }]) {
    const value = await queryProjectGraph({ root: f.root, ...options });
    assert.equal(workNodes(value).length, 1);
    assert.ok(value.nodes.some(node => !isWork(node)), "The single-work rule must count work originals, not navigation nodes");
    const args = expansion(completeNode(value, saved), f, saved);
    assert.ok(args.max_characters > 32768);
    for (const routed of [false, true]) exactResult((await call("head_session_work_read", args, routed)).structuredContent, saved, args);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("graph-generated exact expansion fits the actual enriched record through reader, CLI and direct/router MCP", async t => {
  const f = fixture(t), anchor = f.save({ summary: "Referenced original" });
  const saved = f.save({ judgments: [{ assessment: "Long linked reason", reason: "EnrichedExactNeedle " + "e".repeat(58000), alternatives: ["Keep the original alternatives"] }],
    workLink: { root: { evidenceId: anchor.evidence.evidenceId, evidenceDigest: anchor.evidence.evidenceDigest }, predecessor: { evidenceId: anchor.evidence.evidenceId, evidenceDigest: anchor.evidence.evidenceDigest } },
    executionObservation: { state: "ended", target: { evidenceId: anchor.evidence.evidenceId, evidenceDigest: anchor.evidence.evidenceDigest } },
    references: [{ path: path.relative(f.root, anchor.file).replaceAll("\\", "/"), digest: sha(fs.readFileSync(anchor.file)), kind: "artifact" }], pending: ["X remains"] });
  const value = await queryProjectGraph({ root: f.root, anchorIds: [saved.evidence.evidenceId], depth: 0 });
  const args = expansion(completeNode(value, saved), f, saved);
  const inputFile = path.join(f.base, "exact-reader-input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ evidenceIds: args.evidence_ids, maxRecords: args.max_records, maxCharacters: args.max_characters }));
  const before = snapshot(f.base);
  exactResult(f.read({ evidenceIds: args.evidence_ids, maxRecords: args.max_records, maxCharacters: args.max_characters }), saved, args);
  exactResult(await runCommand(["session-work-read", f.root, "--session", args.session_id, "--input", inputFile]), saved, args);
  for (const routed of [false, true]) exactResult((await call("head_session_work_read", args, routed)).structuredContent, saved, args);
  assert.deepEqual(snapshot(f.base), before);
});

test("multiple small 6073-character reasons automatically fit together beyond the old default body budget", async t => {
  const f = fixture(t), saved = [];
  for (let i = 0; i < 6; i++) saved.push(f.save({ judgments: [{ assessment: `Choice ${i}`, reason: ("SmallBundleReasonNeedle " + String(i) + " ").padEnd(6073, "s"), alternatives: [`Alternative ${i}`] }], pending: [`X${i}`], unknowns: [`Unknown ${i}`] }));
  const before = snapshot(f.base);
  for (const details of [false, true]) {
    const value = await queryProjectGraph({ root: f.root, query: "SmallBundleReasonNeedle", depth: 0, details });
    assert.equal(workNodes(value).length, saved.length);
    for (const original of saved) completeNode(value, original);
    assert.ok(JSON.stringify(workNodes(value).map(node => node.workContent)).length > 32768);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("large multiple work bodies disclose real original excerpts and preserve exact expansion instead of claiming complete text", async t => {
  const f = fixture(t), saved = [];
  for (let i = 0; i < 10; i++) saved.push(f.save({ judgments: [{ assessment: `Large choice ${i}`, reason: `LargeBundleReasonNeedle ${i} 가🙂 ` + String(i).repeat(58000), alternatives: [`Alternative ${i}`] }], pending: [`Pending ${i}`], unknowns: [`Unknown ${i}`] }));
  const before = snapshot(f.base);
  for (const options of [{ details: false, expected: 8 }, { details: true, expected: 10 }, { details: true, maxNodes: 500, expected: 10 }]) {
    const { expected, ...queryOptions } = options;
    const value = await queryProjectGraph({ root: f.root, query: "LargeBundleReasonNeedle", depth: 0, maxEdges: 0, ...queryOptions });
    const nodes = workNodes(value), partial = nodes.filter(node => node.workContentCoverage.partial);
    assert.equal(nodes.length, expected); assert.ok(partial.length > 0);
    for (const node of nodes) {
      const original = saved.find(item => item.evidence.evidenceId === node.nodeId);
      expansion(node, f, original);
      originalExcerpts(node, original);
      if (!node.workContentCoverage.partial) assert.deepEqual(node.workContent, original.evidence.content);
      assert.ok(node.workContent.pending?.length || node.workContentExcerpts?.some(excerpt => excerpt.field === "pending"), "Every represented node must retain its original pending work");
      assert.ok(node.workContent.unknowns?.length || node.workContentExcerpts?.some(excerpt => excerpt.field === "unknowns"), "Every represented node must retain its original unknowns");
    }
    assert.ok(partial.some(node => Array.isArray(node.workContentExcerpts) && node.workContentExcerpts.length > 0), "Partial long reasons need actual original ranges, not paths alone");
    t.diagnostic(JSON.stringify({ scope: "synthetic-graph-presentation-only", details: options.details, maxNodes: value.query.maxNodes, workNodes: nodes.length, partial: partial.length,
      coreCharacters: JSON.stringify(value).length, coreBytes: Buffer.byteLength(JSON.stringify(value)), cliPrettyBytes: Buffer.byteLength(formatCliResult("graph-query", value)) }));
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("escaped semantic text fits real JSON shares without dropping reasons, pending or unknowns", async t => {
  const f = fixture(t), saved = [];
  for (let i = 0; i < 2; i++) saved.push(f.save({
    summary: `EscapedBudgetNeedle ${i}`,
    judgments: [{ assessment: "Keep uncertainty", reason: '"'.repeat(10000), alternatives: [] }],
    pending: ["\\".repeat(5000)], unknowns: ["\u0001".repeat(2000)],
  }));
  const before = snapshot(f.base), options = { root: f.root, query: "EscapedBudgetNeedle", depth: 0, maxEdges: 0 };
  const core = await queryProjectGraph(options), cli = await runCommand(["graph-query", f.root, "--query", options.query, "--depth", "0", "--max-edges", "0"]);
  const mcp = (await call("head_project_graph", { project_root: f.root, query: options.query, depth: 0, max_edges: 0 })).structuredContent;
  for (const result of [core, cli, mcp]) {
    const nodes = workNodes(result); assert.equal(nodes.length, 2);
    assert.ok(nodes.reduce((sum, node) => sum + JSON.stringify({ workContent: node.workContent, workContentExcerpts: node.workContentExcerpts }).length, 0) <= 32768);
    for (const node of nodes) {
      const original = saved.find(item => item.evidence.evidenceId === node.nodeId);
      originalExcerpts(node, original);
      for (const field of ["pending", "unknowns"]) assert.ok(node.workContent[field].length || node.workContentExcerpts.some(e => e.field === field && e.text.length));
      assert.ok(node.workContent.judgments.some(j => j.reason.length) || node.workContentExcerpts.some(e => e.subfield === "reason" && e.text.length));
    }
  }
  assert.deepEqual(workNodes(core).map(n => [n.workContent, n.workContentExcerpts, n.workContentCoverage]), workNodes(mcp).map(n => [n.workContent, n.workContentExcerpts, n.workContentCoverage]));
  assert.deepEqual(snapshot(f.base), before);
});

test("escaped unknowns alone and surrogate-rich reasons preserve exact nonempty ranges", async t => {
  const f = fixture(t), saved = [];
  for (let i = 0; i < 2; i++) saved.push(f.save({ summary: `EscapedUnknownNeedle ${i}`, unknowns: ['"'.repeat(25000)] }));
  for (let i = 0; i < 2; i++) saved.push(f.save({ summary: `SurrogateBudgetNeedle ${i}`,
    judgments: [{ assessment: "Retain code points", reason: '🙂"\\\u0001'.repeat(4000), alternatives: [] }] }));
  for (const query of ["EscapedUnknownNeedle", "SurrogateBudgetNeedle"]) {
    const result = await queryProjectGraph({ root: f.root, query, depth: 0, maxEdges: 0 });
    assert.equal(workNodes(result).length, 2);
    for (const node of workNodes(result)) {
      const original = saved.find(item => item.evidence.evidenceId === node.nodeId); originalExcerpts(node, original);
      const excerpts = node.workContentExcerpts.filter(e => query === "EscapedUnknownNeedle" ? e.field === "unknowns" : e.subfield === "reason");
      assert.ok(excerpts.length > 0);
      for (const entry of excerpts) {
        assert.ok(entry.text.length > 0); assert.equal(entry.text.isWellFormed(), true);
      }
    }
  }
});

test("predecessor-only reason remains bounded in entry and supports graph retrieval and Run-free local continuation", async t => {
  const f = fixture(t), selected = f.session.sessionId;
  const sibling = createHeadSession({ root: f.root, purpose: "Separate synthetic TTL experiment" });
  const args = { project_root: f.root, session_id: selected }, exact = saved => ({
    evidenceId: saved.evidence.evidenceId, evidenceDigest: saved.evidence.evidenceDigest,
  });
  let occurrence = 0;
  const save = async (evidence, sessionId = selected) => {
    // Public writers with deterministic ordering, never edited originals or sleeps.
    const RealDate = globalThis.Date, time = Date.parse("2026-01-01T00:00:00Z") + occurrence++ * 1000;
    globalThis.Date = class extends RealDate {
      constructor(...values) { super(...(values.length ? values : [time])); }
      static now() { return time; }
    };
    try {
      const saved = (await call("head_session_work_record", { project_root: f.root, session_id: sessionId, evidence })).structuredContent;
      assert.equal(saved.writes, 1);
      return saved;
    } finally { globalThis.Date = RealDate; }
  };
  const topic = "PredecessorOnlyCacheQmvt7813";
  const root = await save({ summary: "ROOT: preserve cache generation ordering", workTopics: [topic] });
  const reason = "TTL-only expiry was rejected because a paused older request can finish after its replacement and overwrite it; elapsed time does not prove causal generation order.";
  const middle = await save({ summary: "MIDDLE: an earlier alternative was evaluated", workTopics: [topic],
    workLink: { root: exact(root), predecessor: exact(root) },
    judgments: [{ assessment: "Keep the generation fence", reason, alternatives: ["Rejected TTL-only expiry: late stale completion remains possible"] }],
    unknowns: ["Installed Host and provider behavior remain untested"] });
  for (let i = 0; i < 12; i++) await save({ summary: `Unrelated historical note ${i}`, occurrenceKey: `predecessor-only-${i}` });
  const latest = await save({ summary: "LATEST: checksum export completed once; equal-generation handling remains", workTopics: [topic],
    workLink: { root: exact(root), predecessor: exact(middle) }, observedWork: ["Local checksum export completed exactly once"],
    pending: ["Decide whether TTL-only expiry is adequate for equal-generation duplicate handling"],
    unknowns: ["Native resume and live activity remain unverified"] });
  const other = await save({ summary: "SIBLING ONLY: independent TTL experiment", workTopics: [topic],
    observedWork: ["Separate experiment is not a result of the selected task"] }, sibling.sessionId);
  const current = updateProjectDirection({ root: f.root, input: { goal: "Complete only the authorized local cache correction",
    constraints: ["No provider or remote release; preserve completed checksum export"], cancelledActions: ["publish cache release"] } }).direction;
  const sourceFile = path.join(f.root, "cache.mjs"), effectFile = path.join(f.root, "completed-export.txt");
  const originalCode = "export function apply(state, generation, value) { if (generation < state.generation) return false; state.generation = generation; state.value = value; state.effects += 1; return true; }\n";
  fs.writeFileSync(sourceFile, originalCode); fs.writeFileSync(effectFile, "completed once\n");
  const beforeReads = snapshot(f.base), beforeProject = snapshot(f.root), effectSnapshot = beforeProject["completed-export.txt"];
  const assertEntry = value => {
    assert.equal(value.workContext.sessionId, selected);
    assert.ok(value.workContext.records.every(record => record.sessionId === selected));
    assert.equal(value.workContext.records.some(record => record.evidenceId === other.evidence.evidenceId), false);
    assert.deepEqual(value.projectStatus.currentProjectDirection, current);
    assert.equal(value.projectStatus.state.latestCheckpoint, null);
    assert.equal(value.projectStatus.state.activeRunId, null);
    assert.equal(value.projectStatus.state.activeExecutionContractId, null);
    assert.equal(value.projectStatus.readiness.context.worldModelId, null);
    assert.equal(value.projectStatus.readiness.product.governanceActivated, false);
    assert.equal(value.ordinaryWorkBlocked, false); assert.equal(value.userDecisionRequired, false);
  };
  let middleNode;
  await withoutGraphWrites(async () => {
    const entry = await call("head_conversation_enter", args), work = entry.structuredContent.workContext;
    assertEntry(entry.structuredContent);
    assert.ok(work.records.some(record => record.evidenceId === root.evidence.evidenceId));
    const recent = work.records.find(record => record.evidenceId === latest.evidence.evidenceId);
    assert.ok(recent); assert.deepEqual(recent.content, latest.evidence.content);
    assert.deepEqual(recent.content.workLink.predecessor, exact(middle));
    assert.equal(work.records.some(record => record.evidenceId === middle.evidence.evidenceId), false);
    assert.equal(entry.content[0].text.includes(reason), false);
    assert.ok(entry.content[0].text.includes("publish cache release"));
    assert.equal(entry.content[0].text.includes("SIBLING ONLY"), false);
    assert.equal(work.status, "work_context_partial");
    assert.equal(work.coverage.maxRecords, 8); assert.equal(work.coverage.maxCharacters, 32768);
    assert.equal(work.coverage.originals, 15); assert.equal(work.coverage.included, 8);
    assert.equal(work.coverage.included, work.records.length);
    assert.equal(work.coverage.originals, work.coverage.inspected + work.omissions.uninspected);
    assert.equal(work.coverage.inspected, work.coverage.valid + work.coverage.unavailable);
    assert.ok(work.omissions.uninspected > 0); assert.ok(work.coverage.included <= work.coverage.valid);
    assert.equal(work.coverage.usedCharacters, JSON.stringify(work.records).length);
    assert.ok(work.coverage.usedCharacters < work.coverage.maxCharacters);
    assert.equal(new Set(work.records.map(record => record.evidenceId)).size, work.records.length);
    assert.equal(work.omissions.byBudget, 0); assert.deepEqual(work.omissions.evidenceIds, []);
    const graph = (await call("head_project_graph", { ...args, anchor_ids: [recent.evidenceId], depth: 1, max_nodes: 20, max_edges: 32 })).structuredContent;
    middleNode = completeNode(graph, middle);
    assert.equal(middleNode.workContent.judgments[0].reason, reason);
    assert.equal(workNodes(graph).some(node => node.sessionId === sibling.sessionId), false);
    const edge = graph.edges.find(item => item.type === "FOLLOWS_WORK_EVIDENCE"
      && item.from === latest.evidence.evidenceId && item.to === middle.evidence.evidenceId);
    assert.ok(edge, "The exact latest-to-middle typed predecessor edge must be returned");
    for (const key of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(edge[key], false);
  });
  assert.deepEqual(snapshot(f.base), beforeReads);

  // The graph already supplied the fitting full reason. This harness deliberately
  // chooses a synthetic correction; it does not measure a real model's judgment.
  const beforeOrdinary = snapshot(path.join(f.root, f.layout.directory));
  const prior = await import(pathToFileURL(sourceFile).href + "?red"), red = { generation: 1, value: "old", effects: 0 };
  prior.apply(red, 2, "new"); prior.apply(red, 2, "duplicate"); assert.equal(red.effects, 2);
  fs.writeFileSync(sourceFile, originalCode.replace("generation < state.generation", "generation <= state.generation"));
  const corrected = await import(pathToFileURL(sourceFile).href + "?green"), green = { generation: 1, value: "old", effects: 0 };
  assert.equal(corrected.apply(green, 2, "new"), true);
  assert.equal(corrected.apply(green, 2, "duplicate"), false);
  assert.equal(corrected.apply(green, 1, "stale"), false);
  assert.deepEqual(green, { generation: 2, value: "new", effects: 1 });
  assert.deepEqual(snapshot(path.join(f.root, f.layout.directory)), beforeOrdinary);
  const afterOrdinary = snapshot(f.root);
  assert.deepEqual(Object.keys(afterOrdinary), Object.keys(beforeProject));
  for (const file of Object.keys(beforeProject)) if (file !== "cache.mjs") assert.deepEqual(afterOrdinary[file], beforeProject[file], file);
  assert.notEqual(afterOrdinary["cache.mjs"].digest, beforeProject["cache.mjs"].digest);
  assert.deepEqual(afterOrdinary["completed-export.txt"], effectSnapshot);

  // Reentry is an in-process logical CLI handler read, before any additional save
  // or exact expansion. It is not native conversation resume or Host validation.
  const beforeReentry = snapshot(f.base);
  await withoutGraphWrites(async () => {
    const reentry = await runCommand(["conversation-enter", f.root, "--session", selected]);
    assertEntry(reentry);
    assert.deepEqual(reentry.workContext.records.find(record => record.evidenceId === latest.evidence.evidenceId).content, latest.evidence.content);
    assert.equal(reentry.workContext.records.some(record => record.evidenceId === middle.evidence.evidenceId), false,
      "Reading graph context does not promise to save it or expand future default entry bodies");
  });
  assert.deepEqual(snapshot(f.base), beforeReentry);

  // Optional contract witness only: ordinary work and no-save reentry already
  // succeeded using the sufficient graph body, without this exact read.
  const beforeExact = snapshot(f.base);
  await withoutGraphWrites(async () => {
    const expansionArgs = expansion(middleNode, f, middle);
    exactResult((await call(middleNode.originalExpansion.tool, expansionArgs)).structuredContent, middle, expansionArgs);
  });
  assert.deepEqual(snapshot(f.base), beforeExact);

  // Optional meaningful preservation after the no-save path, not a work gate.
  const handoff = await save({ summary: "HANDOFF: equal-generation duplicate correction passed local checks", workTopics: [topic],
    workLink: { root: exact(root), predecessor: exact(latest) },
    references: [{ path: originalPath(f, middle), digest: sha(fs.readFileSync(middle.file)), kind: "artifact" }],
    observedWork: ["Changed generation < to <=; duplicate and stale inputs add no further local effect"],
    pending: ["Actual installed Host/model resume remains unverified"],
    unknowns: ["This deterministic harness does not measure model judgment"] });
  const beforeHandoffEntry = snapshot(f.base);
  await withoutGraphWrites(async () => {
    const reentry = await runCommand(["conversation-enter", f.root, "--session", selected]);
    assertEntry(reentry);
    assert.deepEqual(reentry.workContext.records.find(record => record.evidenceId === handoff.evidence.evidenceId).content, handoff.evidence.content);
    assert.deepEqual(reentry.workContext.records.find(record => record.evidenceId === middle.evidence.evidenceId).content, middle.evidence.content);
  });
  assert.deepEqual(snapshot(f.base), beforeHandoffEntry);
  assert.deepEqual(snapshot(f.root)["completed-export.txt"], effectSnapshot);
  assert.equal(fs.readFileSync(effectFile, "utf8"), "completed once\n");
});
