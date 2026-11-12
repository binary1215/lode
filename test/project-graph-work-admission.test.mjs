import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session/session-work-context.mjs";
import { queryProjectGraph } from "../scripts/lib/world/project-graph.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/session/cli-presentation.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const selector = (saved) => ({ evidenceId: saved.evidence.evidenceId, evidenceDigest: saved.evidence.evidenceDigest });
const has = (value, saved) => value.nodes.some((node) => node.nodeId === saved.evidence.evidenceId);
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-work-admission-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const session = createHeadSession({ root, purpose: "Synthetic bounded work selection" });
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("head-work-admission-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, session, save: (input) => withSessionRoute(root, session.sessionId, () => recordSessionWorkEvidence({ root, input })) };
}
function body(value, saved) {
  const node = value.nodes.find((node) => node.nodeId === saved.evidence.evidenceId);
  assert.ok(node);
  assert.equal(node.sessionId, saved.evidence.sessionId);
  assert.equal(node.evidenceDigest, saved.evidence.evidenceDigest);
  assert.deepEqual(node.workContent, saved.evidence.content);
  assert.equal(node.contentPartial, false);
  assert.equal(node.workContentCoverage.partial, false);
  assert.equal(node.workContentCoverage.omittedCharacters, 0);
  return node;
}
function snapshot(root) {
  const rows = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else rows.push([path.relative(root, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
  };
  walk(root);
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
function saturated(t, citation = false) {
  const f = fixture(t);
  const root = f.save({
    summary: "Retained objective",
    judgments: [{ assessment: "Keep earlier choice", reason: "OriginalReasonMarker, not superseded", alternatives: ["Do not erase constraints"] }],
  });
  const link = { root: selector(root), predecessor: selector(root) },
    results = [];
  for (let i = 0; i < 8; i++)
    results.push(
      f.save({
        summary: `NeedleResult ${i}`,
        pending: [`PendingMarker ${i}`],
        ...(citation
          ? {
              references: [
                {
                  kind: "artifact",
                  path: path.relative(f.root, root.file).replaceAll("\\", "/"),
                  digest: createHash("sha256").update(fs.readFileSync(root.file)).digest("hex"),
                },
              ],
            }
          : { workLink: link }),
      }),
    );
  return { ...f, first: root, results };
}

test("natural query retains the exact old reason beside matching results in Core, CLI and direct/router MCP", async (t) => {
  const f = saturated(t),
    before = snapshot(f.root),
    args = { root: f.root, view: "work", query: "NeedleResult" };
  const core = await queryProjectGraph(args);
  const inspect = (value) => {
    body(value, f.first);
    assert.ok(value.nodes.length <= 8);
    assert.ok(value.edges.length <= 12);
    assert.equal(new Set(value.nodes.map((n) => n.nodeId)).size, value.nodes.length);
    const included = f.results.filter((saved) => has(value, saved));
    assert.ok(included.length > 0);
    for (const saved of included) body(value, saved);
    assert.equal(value.omittedMatchCount, f.results.length - included.length);
    assert.ok(value.omittedMatchCount > 0);
    assert.equal(value.truncated, true);
    assert.equal(value.nodes.filter((n) => n.nodeId === f.first.evidence.evidenceId).length, 1);
    return included;
  };
  inspect(core);
  inspect(await runCommand(["graph-query", f.root, "--query", "NeedleResult", "--view", "work"]));
  for (const routed of [false, true]) {
    const name = "head_project_graph",
      arguments_ = { project_root: f.root, query: "NeedleResult", view: "work" };
    const response = await dispatch({
      id: "admission",
      method: "tools/call",
      params: {
        name: routed ? "head_tools_read" : name,
        arguments: routed ? { name, arguments: arguments_ } : arguments_,
      },
    });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true);
    const value = response.result.structuredContent,
      included = inspect(value),
      text = response.result.content[0].text;
    assert.ok(text.includes("OriginalReasonMarker, not superseded"));
    assert.ok(text.includes("Do not erase constraints"));
    for (const saved of included) assert.ok(text.includes(saved.evidence.content.pending[0]));
    assert.ok(text.includes("Logical Session S"));
    const diagnostics = formatCliResult("graph-query", value, { diagnostics: true, columns: 240 });
    assert.ok(diagnostics.includes(f.session.sessionId));
    assert.ok(diagnostics.includes(f.first.evidence.evidenceDigest));
    t.diagnostic(
      JSON.stringify({
        routed,
        bodyBytes: Buffer.byteLength(JSON.stringify(value.nodes.filter((n) => n.workContent).map((n) => n.workContent))),
        textBytes: Buffer.byteLength(text),
        structuredBytes: Buffer.byteLength(JSON.stringify(value)),
        wrapperBytes: Buffer.byteLength(JSON.stringify(response)),
      }),
    );
  }
  assert.deepEqual(snapshot(f.root), before, "Discovery and formatters do not write");
});

test("exact citations share admission without inventing a declared root or approval", async (t) => {
  const f = saturated(t, true),
    value = await queryProjectGraph({ root: f.root, query: "NeedleResult", view: "work" });
  body(value, f.first);
  assert.ok(value.edges.some((e) => e.type === "CITES_WORK_EVIDENCE" && e.to === f.first.evidence.evidenceId));
  assert.equal(
    value.edges.some((e) => e.type === "DECLARES_WORK_ROOT"),
    false,
  );
  for (const node of value.nodes.filter((n) => n.workContent))
    for (const key of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(node[key], false);
});

test("seed fallback, explicit selectors and zero edge/depth limits keep existing meanings", async (t) => {
  const f = saturated(t);
  for (const extra of [{ maxNodes: 1 }, { maxEdges: 0 }, { depth: 0 }, { anchorIds: f.results.map((s) => s.evidence.evidenceId) }]) {
    const value = await queryProjectGraph({ root: f.root, query: "NeedleResult", view: "work", ...extra });
    assert.equal(has(value, f.first), false);
    assert.ok(
      f.results.some((s) => has(value, s)),
      "No all-or-nothing companion gate",
    );
    assert.ok(value.nodes.length <= (extra.maxNodes || 8));
    assert.ok(value.edges.length <= (extra.maxEdges ?? 12));
  }
  const exact = await queryProjectGraph({
    root: f.root,
    query: "NeedleResult",
    paths: [path.relative(f.root, f.results[0].file).replaceAll("\\", "/")],
    maxNodes: 1,
  });
  assert.equal(has(exact, f.results[0]), true);
  assert.equal(has(exact, f.first), false);
  const product = await queryProjectGraph({ root: f.root, query: "NeedleResult", view: "product" });
  assert.equal(
    product.nodes.some((n) => n.workContent),
    false,
  );
  const oneEdge = await queryProjectGraph({ root: f.root, query: "NeedleResult", view: "work", maxEdges: 1 });
  assert.ok(has(oneEdge, f.first));
  assert.equal(oneEdge.edges.length, 1);
  assert.equal(oneEdge.edges[0].type, "DECLARES_WORK_ROOT");
  assert.equal(new Set(oneEdge.edges.map((e) => e.edgeId)).size, oneEdge.edges.length);
});

test("preadmitted companion is depth one, yet normal depth two remains reachable", async (t) => {
  const f = fixture(t),
    cited = f.save({ summary: "ThirdHopMarker" });
  const first = f.save({
    summary: "Earlier reason",
    references: [
      {
        kind: "artifact",
        path: path.relative(f.root, cited.file).replaceAll("\\", "/"),
        digest: createHash("sha256").update(fs.readFileSync(cited.file)).digest("hex"),
      },
    ],
  });
  const result = f.save({ summary: "SingleSeedMarker", workLink: { root: selector(first), predecessor: selector(first) } });
  const one = await queryProjectGraph({ root: f.root, query: "SingleSeedMarker", depth: 1 });
  assert.ok(has(one, result));
  assert.ok(has(one, first));
  assert.equal(has(one, cited), false);
  const two = await queryProjectGraph({ root: f.root, query: "SingleSeedMarker", depth: 2 });
  assert.ok(has(two, cited));
  assert.equal(two.inclusion.find((i) => i.nodeId === cited.evidence.evidenceId).reason, "relation-depth-2");
});
