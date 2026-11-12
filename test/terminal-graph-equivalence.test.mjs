import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatCliResult, formatMcpToolContent } from "../scripts/lib/session/cli-presentation.mjs";
import { formatTerminalGraph } from "../scripts/lib/world/terminal-graph.mjs";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { prepareSourceContext } from "../scripts/lib/world/source-context-workflow.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const graph = () => ({
  kind: "ProjectGraphDiscoveryProjection",
  status: "available",
  basis: { projectId: "generic-project" },
  nodes: [
    { nodeId: "version-a", kind: "SourceRevision", revisionId: `source-revision-${"a".repeat(64)}`, historical: true, freshness: "historical" },
    { nodeId: "version-b", kind: "SourceRevision", revisionId: `source-revision-${"b".repeat(64)}`, freshness: "current" },
    {
      nodeId: "work",
      kind: "Evidence",
      subtype: "SessionWorkEvidence",
      origin: { layer: "sessionWork" },
      projectId: "generic-project",
      sessionId: "owner",
      workContent: { summary: "Unique recorded reason", pending: ["Unresolved work"], unknowns: ["Uncertain result"], future: { marker: false } },
    },
  ],
  edges: [
    { from: "work", to: "version-a", type: "REFERENCES" },
    { from: "version-a", to: "work", type: "REFERENCES" },
    { from: "work", to: "work", type: "REFERENCES" },
    { from: "work", to: "version-a", type: "REFERENCES" },
    { from: "work", to: "outside", type: "REFERENCES" },
  ],
  coverage: { state: "partial", emptyResultProvesAbsence: false },
  future: { unknown: null },
});

test("CLI and both MCP names use one graph renderer, preserve distinct revisions and do not repeat bodies", () => {
  const value = graph(),
    original = structuredClone(value),
    cli = formatCliResult("graph-query", value);
  for (const name of ["head_project_graph", "lode_project_graph"]) assert.equal(formatMcpToolContent(name, value), cli);
  assert(cli.includes("a".repeat(16)));
  assert(cli.includes("b".repeat(16)));
  assert.equal(cli.split("Unique recorded reason").length - 1, 1);
  assert(cli.includes("Unresolved work"));
  assert(cli.includes("Uncertain result"));
  assert(cli.includes("partial"));
  assert(cli.includes("outside selection: outside"));
  assert.equal(cli.split("--REFERENCES-->").length - 1, 5);
  assert.deepEqual(value, original);
  const exact = formatTerminalGraph(value, { diagnostics: true, columns: 240 });
  assert(exact.includes(value.nodes[0].revisionId));
  assert(exact.includes('"marker": false'));
  assert(exact.includes('"unknown": null'));
});

test("revision previews retain identifier bodies across kinds, with exact IDs in diagnostics", () => {
  const ids = [
    "symbol-revision-aaaaaaaa11111111",
    "symbol-revision-bbbbbbbb22222222",
    "source-snapshot-cccccccc33333333",
    "file-revision-dddddddd44444444",
    "opaque-long-prefix-eeeeeeee55555555",
    "short-id",
  ];
  const value = graph();
  value.nodes = ids.map((revisionId, index) => ({ nodeId: `r${index}`, kind: "Revision", revisionId }));
  value.edges = [];
  const original = structuredClone(value),
    text = formatTerminalGraph(value, { columns: 240 });
  for (const id of ids) assert(text.includes(id.length > 16 ? `…${id.slice(-16)}` : id));
  const diagnostics = formatTerminalGraph(value, { columns: 240, diagnostics: true });
  for (const id of ids) assert(diagnostics.includes(id));
  assert.deepEqual(value, original);
});

test("MCP shared graph text neutralizes terminal controls while raw selected evidence is unchanged", () => {
  const value = graph();
  const unsafe = "ESC:\u001b[31m OSC:\u001b]0;title\u0007 bidi:\u202eend";
  value.nodes[2].workContent.summary = unsafe;
  value.nodes[0].revisionId = "source-revision-\u001b]0;x\u0007abcdef";
  value.contextLineage = { events: [{ nodeId: "work", sourceRole: unsafe, cancelledActions: [unsafe] }] };
  const original = JSON.stringify(value);
  for (const width of [16, 88, 240]) {
    const text = formatTerminalGraph(value, { columns: width });
    assert(!/[\u001b\u0007\u202e]/u.test(text));
  }
  assert(!/[\u001b\u0007\u202e]/u.test(formatMcpToolContent("head_project_graph", value)));
  assert.equal(JSON.stringify(value), original);
});

test("default context text retains unknown provenance, cancellation and partial state without repeating known provenance", () => {
  const value = graph();
  value.contextLineage = {
    events: [
      { nodeId: "work", sourceRole: "HEAD-authored-P3-work-evidence-not-user-transcript", reviewState: "unreviewed", freshness: "historical" },
      {
        nodeId: "version-a",
        sourceRole: "Unknown role must remain unknown",
        cancelledActions: ["Do not deploy"],
        contentPartial: true,
        missingLink: "Original not linked",
      },
    ],
  };
  const original = structuredClone(value),
    text = formatMcpToolContent("lode_project_graph", value);
  assert.equal(text, formatCliResult("graph-query", value));
  assert(text.includes("Unknown role must remain unknown"));
  assert(text.includes("Do not deploy"));
  assert(text.includes("Partial context excerpt"));
  assert(text.includes("Original not linked"));
  assert(!text.includes("HEAD-authored-P3-work-evidence-not-user-transcript"));
  assert.equal(text.split("Agent-authored work evidence").length - 1, 1);
  assert.deepEqual(value, original);
  const withoutBody = structuredClone(value);
  withoutBody.nodes[2].workContent = null;
  assert(formatMcpToolContent("lode_project_graph", withoutBody).includes("Agent-authored work evidence; not a captured user transcript"));
});

test("actual MCP request handler retains complete structuredContent and leaves synthetic originals unchanged", async (t) => {
  const parent = fs.realpathSync(os.tmpdir()),
    root = fs.mkdtempSync(path.join(parent, "lode-terminal-eq-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("lode-terminal-eq-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot: path.resolve(import.meta.dirname, ".."), runtimes: ["codex"] });
  fs.writeFileSync(path.join(root, "generic.mjs"), "export const generic = 1;\n");
  await prepareSourceContext({ root, task: "Inspect generic source", needs: [{ kind: "source", path: "generic.mjs" }], retain: true });
  const snapshot = () =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = path.join(e.parentPath, e.name);
        return [path.relative(root, p), fs.readFileSync(p).toString("base64")];
      })
      .sort(([a], [b]) => a.localeCompare(b));
  const before = snapshot();
  for (const details of [false, true]) {
    const response = await dispatch({
      id: 1,
      method: "tools/call",
      params: { name: "head_project_graph", arguments: { project_root: root, query: "generic", details } },
    });
    assert.equal(response.error, undefined);
    const { structuredContent, content } = response.result;
    const rawBefore = JSON.stringify(structuredContent);
    assert.equal(content[0].text, formatCliResult("graph-query", structuredContent));
    assert.equal(content[0].text, formatMcpToolContent("head_project_graph", structuredContent));
    assert.equal(JSON.stringify(structuredContent), rawBefore);
    assert(structuredContent.nodes.length > 0);
    assert(structuredContent.coverage);
    assert(structuredContent.sourceFallback);
    assert.deepEqual(snapshot(), before);
  }
});
