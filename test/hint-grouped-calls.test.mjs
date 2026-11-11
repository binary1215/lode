import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicHintCall, publicHintText, publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { groupMembership, resolveGroupedCall } from "../scripts/lib/operation-groups.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { catalogTools, dispatch, discoverTools, tools } from "../scripts/mcp-server.mjs";

// User decision (2026-11-11, option d): runtime hints name the grouped callable
// form, never a deprecated alias (removed in 0.5.0).

const pluginRoot = path.resolve(import.meta.dirname, "..");
const call = (name, args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

// Every tool-name literal that runtime code hands to a hint builder. Verification
// and measurement scripts (scripts/verify-*, measure-*, generate-*) call deprecated
// names on purpose to prove they still work, so they are not hints.
function hintLiterals() {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".mjs") && !/^(verify|measure|generate)-/.test(entry.name)) {
        const text = fs.readFileSync(file, "utf8");
        for (const match of text.matchAll(/\b(publicToolName|publicHintCall|publicHintText)\(\s*"([a-z_]+)"/g))
          found.push({ file: path.relative(pluginRoot, file).replaceAll("\\", "/"), builder: match[1], name: match[2] });
        // Name lists mapped through a hint builder, e.g. ["lode_x", "lode_y"].map(...publicHintCall...).
        for (const match of text.matchAll(/\[((?:\s*"[a-z_]+",?)+)\s*\]\.map\(\s*(?:\(name\)\s*=>\s*)?(publicToolName|publicHintCall)/g))
          for (const name of match[1].match(/"([a-z_]+)"/g))
            found.push({ file: path.relative(pluginRoot, file).replaceAll("\\", "/"), builder: match[2], name: name.slice(1, -1) });
      }
    }
  };
  walk(path.join(pluginRoot, "scripts"));
  return found;
}

test("no hint literal names a deprecated alias; grouped operations go through the hint builders", () => {
  const literals = hintLiterals();
  assert.ok(literals.length > 20, "the scan finds the hint builders");
  const deprecated = literals.filter(({ builder, name }) => builder === "publicToolName" && groupMembership(resolveOperation(name)?.canonicalName ?? name));
  assert.deepEqual(deprecated, [], "use publicHintCall/publicHintText for grouped operations");
  const listed = new Set([...tools, ...catalogTools].map((tool) => tool.name));
  for (const { builder, name, file } of literals) {
    if (builder === "publicToolName") continue;
    const { tool } = publicHintCall(name);
    assert.equal(groupMembership(tool), null, `${file}: ${name} hints ${tool}`);
    assert.ok(listed.has(tool), `${file}: ${name} hints ${tool}, which discovery lists`);
    assert.equal(discoverTools({ name: tool }).tools[0].name, tool);
  }
});

test("hint builders return the grouped tool with its action first, or the single operation", () => {
  assert.deepEqual(publicHintCall("lode_onboarding_guide"), { tool: publicToolName("lode_onboarding"), arguments: { action: "guide" } });
  assert.deepEqual(publicHintCall("lode_session_work_read", { session_id: "s", max_records: 1 }), {
    tool: publicToolName("lode_session"),
    arguments: { action: "work_read", session_id: "s", max_records: 1 },
  });
  assert.deepEqual(publicHintCall("lode_project_bundle_import"), { tool: publicToolName("lode_project_bundle"), arguments: { action: "import" } });
  assert.deepEqual(publicHintCall("lode_temporal_graph"), { tool: publicToolName("lode_temporal_graph"), arguments: {} });
  assert.equal(publicHintText("lode_work_document_prepare"), `${publicToolName("lode_work_document")} (action: prepare)`);
  assert.equal(publicHintText("lode_temporal_graph"), publicToolName("lode_temporal_graph"));
  assert.throws(() => publicHintCall("lode_not_an_operation"), /Unknown hint operation/);
});

test("each hinted call, made exactly as hinted, resolves to the same operation as its alias", async () => {
  for (const { name } of hintLiterals()) {
    const operation = resolveOperation(name).canonicalName;
    const hint = publicHintCall(operation, { project_root: "/nowhere-lode-hint-test" });
    const resolved = resolveGroupedCall(hint.tool, hint.arguments);
    assert.equal(resolved ? resolved.name : resolveOperation(hint.tool).canonicalName, operation, name);
    if (!groupMembership(operation)) continue;
    // Same outcome as calling the deprecated alias with the same arguments.
    const { action, ...rest } = hint.arguments;
    const [grouped, alias] = [await call(hint.tool, hint.arguments), await call(operation, rest)];
    assert.deepEqual(grouped, alias, `${hint.tool} ${action}`);
  }
});

test("structured hints from a real Project are callable as returned", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-hint-calls-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "README.md"), "# Hint fixture\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const status = (await call("lode_project_status", { project_root: root })).result.structuredContent;
  const entrypoints = [];
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.mcpTool === "string") entrypoints.push({ tool: value.mcpTool, arguments: value.mcpArguments ?? {} });
    for (const entry of Object.values(value)) collect(entry);
  };
  collect(status);
  assert.ok(entrypoints.length > 0, "status carries at least one MCP entrypoint");
  for (const entry of entrypoints) {
    assert.equal(groupMembership(entry.tool), null, entry.tool);
    const response = await call(entry.tool, { ...entry.arguments, project_root: root });
    assert.notEqual(response.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(response));
    assert.doesNotMatch(response.error?.message ?? "", /Unknown tool/);
  }
});
