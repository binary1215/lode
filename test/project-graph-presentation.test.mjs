import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatMcpToolContent, formatCliResult, formatSessionWorkContext } from "../scripts/lib/session/cli-presentation.mjs";
import { organizeSelectedWorkBodies, workBodyTuples } from "../scripts/lib/session/session-work-body-organization.mjs";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { prepareSourceContext } from "../scripts/lib/world/source-context-workflow.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { terminalBlock } from "../scripts/lib/world/terminal-graph.mjs";
import { assertTerminalGraphPresentation } from "./helpers/terminal-graph-assertions.mjs";

const render = (value) => formatMcpToolContent("head_project_graph", value);
const call = (root, args = {}) => dispatch({ id: 1, method: "tools/call", params: { name: "head_project_graph", arguments: { project_root: root, ...args } } });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-graph-json-")));
  t.after(() => {
    assert(path.basename(root).startsWith("head-graph-json-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bytes(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else entries.push([path.relative(root, file), fs.readFileSync(file).toString("base64")]);
    }
  };
  walk(root);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

test("unrecognized graph shapes keep exact MCP JSON and an inert labeled CLI fallback", () => {
  for (const value of [null, false, "unknown", {}, { kind: "ProjectGraphDiscoveryProjection", nodes: null, edges: [] }]) {
    const original = JSON.stringify(value);
    assert.equal(render(value), original);
    assert.deepEqual(JSON.parse(render(value)), JSON.parse(original));
    assert.equal(JSON.stringify(value), original);
    assert.equal(formatCliResult("graph-query", value), terminalBlock("Unrecognized graph result", JSON.stringify(value, null, 2)));
  }
});

function jsonMember(text, key, value) {
  assert(text.includes(JSON.stringify({ [key]: value }, null, 2).slice(2, -2)), key);
}

test("shared graph view keeps meaning while complete unknown fields retain their original structured scopes", () => {
  const value = {
    kind: "ProjectGraphDiscoveryProjection",
    status: "available",
    query: { details: false },
    nodes: [
      {
        nodeId: "rejected",
        sessionId: "owner-A",
        reviewState: "rejected",
        excerpt: "Do not execute this historical plan.",
        sourceAuthority: { plane: "P3" },
        "future: field": { list: [null, false, 0, [], {}, 'Ω\nquoted"'] },
      },
      { nodeId: "other", sessionId: "owner-B", future: null },
    ],
    edges: [{ from: "rejected", to: "other", kind: "REFERENCES", future: false }, {}],
    coverage: { state: "partial", emptyResultProvesAbsence: false },
    future: [],
  };
  const original = JSON.stringify(value),
    text = render(value);
  const cli = formatCliResult("graph-query", value);
  const { sections, sessions } = assertTerminalGraphPresentation(cli, value);
  assert(sections[0].includes(value.nodes[0].excerpt));
  assert(sections[0].includes("rejected"));
  assert.notEqual(sessions.get("owner-A"), sessions.get("owner-B"));
  assert.equal(JSON.stringify(value), original);
  assert(text.includes(value.nodes[0].excerpt));
  assert.equal(text, cli);
  assert.notEqual(sessions.get("owner-A"), sessions.get("owner-B"));
  // Default text is the same concise view as CLI. Exact metadata is not
  // reprinted there; it remains in structuredContent and optional diagnostics.
  const exact = formatCliResult("graph-query", value, { diagnostics: true, columns: 240 });
  for (const key of ['"future: field"', '"sourceAuthority"', '"future": null', '"future": false', '"future": []']) assert(exact.includes(key));
  assert.equal(JSON.stringify(value), original);
});

test("actual MCP default, compact and detailed text retain structuredContent and readonly source scope", async (t) => {
  const root = fixture(t);
  initializeProject({ root, pluginRoot: path.resolve(import.meta.dirname, ".."), runtimes: ["codex"] });
  fs.writeFileSync(path.join(root, "module.mjs"), "export const answer = 42;\n");
  await prepareSourceContext({ root, task: "Inspect selected source", needs: [{ kind: "source", path: "module.mjs" }], retain: true });
  const before = bytes(root);
  for (const args of [{}, { details: false }, { details: true }]) {
    const response = await call(root, { query: "module", depth: 3, max_nodes: 50, max_edges: 80, ...args });
    assert.equal(response.error, undefined);
    // dispatch is in-process; MCP JSON transport omits optional undefined keys
    // from structuredContent as well as from its JSON text representation.
    const { structuredContent: value, content } = JSON.parse(JSON.stringify(response.result));
    assert(value.nodes.length > 0);
    assert(value.edges.length > 0);
    assert.equal(value.query.details, args.details ?? false);
    assert.equal(content[0].text, render(value));
    assertTerminalGraphPresentation(formatCliResult("graph-query", value), value);
    assert.equal(content[0].text, formatCliResult("graph-query", value));
    const raw = JSON.stringify(value);
    const exact = formatCliResult("graph-query", value, { diagnostics: true, columns: 240 });
    for (const node of value.nodes) assert(exact.includes(node.nodeId));
    for (const key of ["coverage", "sourceFallback", "boundary"]) if (Object.hasOwn(value, key)) assert(exact.includes(`"${key}"`));
    assert.equal(JSON.stringify(value), raw);
    const original = JSON.stringify(value);
    Object.freeze(value);
    assert.equal(render(value), content[0].text);
    assert.equal(JSON.stringify(value), original);
    assert.deepEqual(bytes(root), before);
  }
});

test("MCP unavailable-source text keeps fallback and authority boundaries without initializing or writing", async (t) => {
  const root = fixture(t),
    before = bytes(root),
    response = await call(root);
  assert.equal(response.error, undefined);
  const { structuredContent: value, content } = response.result;
  assert.equal(value.status, "source-fallback");
  assert.equal(content[0].text, render(value));
  assert.equal(content[0].text, formatCliResult("graph-query", value));
  assert(content[0].text.includes("Source follow-up needed"));
  assert(content[0].text.includes("not proof of completeness or absence"));
  assert.equal(value.sourceFallback.needed, true);
  assert.equal(value.authority.ordinaryWorkBlocked, false);
  assert.equal(value.coverage.emptyResultProvesAbsence, false);
  assert.deepEqual(bytes(root), before);
});

test("shared default view leaves exact metadata and unexpected values available in unchanged structured evidence", () => {
  const node = {
    kind: "Evidence",
    subtype: "SessionWorkEvidence",
    nodeId: "work-one",
    projectId: "project-one",
    sessionId: "owner-one",
    evidenceDigest: "exact-digest",
    workContent: { summary: "Do not apply cancelled work", pending: ["X remains"], unknowns: ["Unknown condition"], executionAuthority: false },
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    executionAuthority: false,
    ordinaryWorkBlocked: false,
    authorityBoundary: { unknownPolicy: false },
  };
  const value = { kind: "ProjectGraphDiscoveryProjection", nodes: [node], edges: [], query: { details: false }, coverage: { state: "partial", unknown: null } };
  const before = structuredClone(value),
    text = render(value);
  assert.deepEqual(value, before);
  assert.equal(text, formatCliResult("graph-query", value));
  assert.ok(text.includes("Do not apply cancelled work"));
  assert.ok(text.includes("X remains"));
  assert.ok(text.includes("Unknown condition"));
  const exact = formatCliResult("graph-query", value, { diagnostics: true, columns: 240 });
  assert(exact.includes('"executionAuthority": false'));
  assert(exact.includes('"authorityBoundary"'));
  for (const unexpected of [true, null, 0, "false", [], {}]) {
    const changed = structuredClone(value);
    changed.nodes[0].promotionAuthority = unexpected;
    const original = JSON.stringify(changed);
    render(changed);
    assert(formatCliResult("graph-query", changed, { diagnostics: true, columns: 240 }).includes(`"promotionAuthority": ${JSON.stringify(unexpected)}`));
    assert.equal(JSON.stringify(changed), original);
  }
  const detailed = structuredClone(value);
  detailed.query.details = true;
  assert.equal(render(detailed), formatCliResult("graph-query", detailed));
  assert.deepEqual(value, before);
});

test("only complete exact rendered body-group metadata is factored; unknown, partial and owner differences stay visible", () => {
  const record = {
    kind: "Evidence",
    subtype: "SessionWorkEvidence",
    evidenceId: "work-one",
    evidenceDigest: "digest-one",
    projectId: "project-one",
    sessionId: "owner-one",
    content: { summary: "Original reason", workTopics: ["Topic one"], pending: ["X remains"], unknowns: [] },
  };
  const value = {
    kind: "SessionWorkContextProjection",
    status: "work_context_available",
    projectId: "project-one",
    sessionId: "owner-one",
    records: [record],
    coverage: { originals: 1 },
    persisted: false,
    recoveryAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    executionReplayAllowed: false,
    ordinaryWorkBlocked: false,
  };
  value.selectedBodyGroups = { ...organizeSelectedWorkBodies(workBodyTuples(value.records, value)), omittedGroups: 0 };
  const before = structuredClone(value),
    text = formatSessionWorkContext(value);
  assert.deepEqual(value, before);
  assert.equal(text.includes('"selectedBodyGroups"'), false);
  assert.ok(text.includes("owner-one"));
  assert.ok(text.includes("Topic one"));
  assert.ok(text.includes("X remains"));
  for (const change of [
    (group) => {
      group.omittedGroups = 1;
    },
    (group) => {
      group.futureCondition = false;
    },
    (group) => {
      delete group.scope;
    },
    (group) => {
      group.groups[0].sessionId = "other-owner";
    },
    (group) => {
      group.groups[0].rootBodyIndex = null;
    },
  ]) {
    const altered = structuredClone(value);
    change(altered.selectedBodyGroups);
    jsonMember(formatSessionWorkContext(altered), "selectedBodyGroups", altered.selectedBodyGroups);
  }
  for (const groups of [null, false, [], {}]) {
    const altered = { ...value, selectedBodyGroups: groups };
    jsonMember(formatSessionWorkContext(altered), "selectedBodyGroups", groups);
  }
  for (const unexpected of [true, null, 0, "false"]) {
    const altered = { ...value, ordinaryWorkBlocked: unexpected, interpretation: "Changed condition, not normal prose", future: { qualifier: null } };
    const changedText = formatSessionWorkContext(altered);
    jsonMember(changedText, "ordinaryWorkBlocked", unexpected);
    jsonMember(changedText, "interpretation", altered.interpretation);
    jsonMember(changedText, "future", altered.future);
    assert.equal(changedText.includes("Ordinary work remains available."), false);
  }
  assert.notEqual(formatSessionWorkContext({ ...value, status: "work_context_not_recorded", coverage: { originals: null }, records: [] }), "");
});
