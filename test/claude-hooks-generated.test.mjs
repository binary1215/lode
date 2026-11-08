import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_HOOKS_FILE, generateClaudeHooks, renderClaudeHooks } from "../scripts/lib/claude-hooks-generation.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { sessionCallRequiresBinding } from "../scripts/lib/session-routing.mjs";
import { catalogTools, toolsForSurface } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const committed = fs.readFileSync(path.join(pluginRoot, CLAUDE_HOOKS_FILE), "utf8");
const committedHooks = JSON.parse(committed);
const namespaces = ["mcp__lode__", "mcp__plugin_lode-agent-core_lode__"];
const matchers = committedHooks.hooks.PreToolUse.map((group) => new RegExp(group.matcher));
const alternatives = (group) => group.matcher.match(/__\((.*)\)\$$/)[1].split("|");

test("committed hooks/claude.json is byte-identical to the generator output", () => {
  assert.equal(renderClaudeHooks(committed, catalogTools), committed, "hooks/claude.json is stale; run: node scripts/generate-claude-hooks.mjs");
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts/generate-claude-hooks.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "current", file: CLAUDE_HOOKS_FILE });
});

test("generation replaces only the two PreToolUse matchers and --check never writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-claude-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = structuredClone(committedHooks);
  for (const group of stale.hooks.PreToolUse) group.matcher = "^mcp__lode__(stale)$";
  fs.mkdirSync(path.join(root, "hooks"));
  const file = path.join(root, CLAUDE_HOOKS_FILE),
    staleText = `${JSON.stringify(stale, null, 2)}\n`;
  fs.writeFileSync(file, staleText);
  assert.deepEqual(await generateClaudeHooks({ root, check: true }), { status: "stale", file: CLAUDE_HOOKS_FILE });
  assert.equal(fs.readFileSync(file, "utf8"), staleText, "--check is read-only");
  assert.deepEqual(await generateClaudeHooks({ root }), { status: "written", file: CLAUDE_HOOKS_FILE });
  assert.equal(fs.readFileSync(file, "utf8"), committed, "only the matchers differed");
  assert.deepEqual(await generateClaudeHooks({ root, check: true }), { status: "current", file: CLAUDE_HOOKS_FILE });
  const reordered = structuredClone(committedHooks);
  reordered.hooks.PreToolUse.reverse();
  assert.throws(() => renderClaudeHooks(JSON.stringify(reordered), catalogTools), { code: "CLAUDE_HOOKS_SHAPE_UNEXPECTED" });
});

test("default tools/list and router-reachable tools follow the Session/effect matcher rule", () => {
  const rule = (tool) =>
    resolveOperation(tool.name).router ||
    sessionCallRequiresBinding(tool.name) ||
    tool.annotations?.readOnlyHint !== true ||
    tool.name === "lode_conversation_list";
  const listed = toolsForSurface().filter((tool) => tool.name !== "lode_session_host_request_prepare");
  assert.equal(listed.length, toolsForSurface().length - 1);
  for (const tool of [...listed, ...catalogTools.filter((tool) => tool.name !== "lode_session_host_request_prepare")]) {
    namespaces.forEach((namespace, index) => assert.equal(matchers[index].test(namespace + tool.name), rule(tool), tool.name));
  }
  // The routers relay Session-bound and effectful inner calls.
  for (const router of ["lode_tools_read", "lode_tools_call"]) {
    namespaces.forEach((namespace, index) => assert.equal(matchers[index].test(namespace + router), true, router));
  }
  // Independent read-only entries carry no Session binding and stay unmatched.
  for (const name of ["lode_tools_discover", "lode_project_graph", "lode_session_list", "lode_project_direction_read"]) {
    namespaces.forEach((namespace, index) => assert.equal(matchers[index].test(namespace + name), false, name));
  }
});

test("every matcher alternative is a known operation, and legacy spellings only twin a canonical one", () => {
  for (const group of committedHooks.hooks.PreToolUse) {
    const names = alternatives(group);
    assert.deepEqual(names, [...names].sort());
    for (const name of names) {
      const operation = resolveOperation(name);
      assert.ok(operation, name);
      assert.ok(names.includes(operation.canonicalName) && names.includes(operation.legacyName), name);
    }
    assert.equal(names.filter((name) => name.startsWith("lode_")).length * 2, names.length);
  }
});
