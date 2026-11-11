import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicHintCall, publicHintText, publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { effectiveToolCall, groupMembership, resolveGroupedCall } from "../scripts/lib/operation-groups.mjs";
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

// Files whose deprecated names are routing or dispatch tables, not hints.
const ROUTING_FILES = new Set([
  "scripts/lib/operation-registry.mjs",
  "scripts/lib/lode-operation-contract.mjs",
  "scripts/lib/operation-groups.mjs",
  "scripts/lib/session-routing.mjs",
  "scripts/lib/work-document-surface.mjs",
  "scripts/lib/managed-maintenance-surface.mjs",
]);
// Line-level dispatch: formatter selection by operation name, and the MCP
// server's per-operation cancellation hook.
const DISPATCH_LINE = /\bname === "|\]\.includes\(name\)|requestedToolName\(request\) === "/;

// Scope: every whole-word lode_/head_ token in runtime scripts/**/*.mjs. Not
// covered: names assembled by concatenation or template interpolation, lines that
// match DISPATCH_LINE, the routing files above, non-.mjs files, and
// verify-/measure-/generate- scripts.
test("no runtime string literal names a deprecated alias outside routing tables", () => {
  const misses = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(pluginRoot, file).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".mjs") && !/^(verify|measure|generate)-/.test(entry.name) && !ROUTING_FILES.has(relative))
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (DISPATCH_LINE.test(line)) return;
            // A name handed to a hint builder is its input, not its output.
            const scanned = line.includes(".map((name) => publicHintCall(name))")
              ? line.replace(/"[a-z_]+"/g, "")
              : line.replace(/\b(?:publicHintCall|publicHintText|hintEntrypoint|compactHintCall)\(\s*"[a-z_]+"/g, "");
            for (const [token] of scanned.matchAll(/\b(?:lode|head)_[a-z_]+\b/g)) {
              const operation = resolveOperation(token)?.canonicalName;
              if (operation && groupMembership(operation)) misses.push(`${relative}:${index + 1} ${token}`);
            }
          });
    }
  };
  walk(path.join(pluginRoot, "scripts"));
  assert.deepEqual(misses, [], "name the grouped tool through publicHintCall/publicHintText");
});

test("hint builders return the grouped tool with its action first, or the single operation", () => {
  assert.throws(() => publicHintCall("lode_onboarding_guide", { action: "review" }), /cannot carry an action/);
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
  // The context readiness entrypoint, called exactly as returned (plus the
  // Project root it leaves to the caller), reaches lode_context_prepare.
  const entry = status.readiness.context.entrypoint;
  assert.deepEqual(entry.mcpArguments, { action: "prepare" });
  assert.equal(groupMembership(entry.mcpTool), null, entry.mcpTool);
  assert.equal(effectiveToolCall(entry.mcpTool, entry.mcpArguments).name, "lode_context_prepare");
  const response = await call(entry.mcpTool, { ...entry.mcpArguments, project_root: root, task: "Inspect the README" });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.isError, undefined);
});
