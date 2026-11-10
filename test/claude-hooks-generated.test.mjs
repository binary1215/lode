import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_HOOKS_FILE, generateClaudeHooks, renderClaudeHooks } from "../scripts/lib/claude-hooks-generation.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { sessionCallRequiresBinding } from "../scripts/lib/session-routing.mjs";
import { catalogTools, operationCatalogTools, toolsForSurface } from "../scripts/mcp-server.mjs";
import { operationGroup } from "../scripts/lib/operation-groups.mjs";
import { legacyOperationName } from "../compat/head/public-names.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const committed = fs.readFileSync(path.join(pluginRoot, CLAUDE_HOOKS_FILE), "utf8");
const committedHooks = JSON.parse(committed);
const namespaces = ["mcp__lode__", "mcp__plugin_lode-agent-core_lode__"];
const matchers = committedHooks.hooks.PreToolUse.map((group) => new RegExp(group.matcher));
const alternatives = (group) => group.matcher.match(/__\((.*)\)\$$/)[1].split("|");

test("committed hooks/claude.json is byte-identical to the generator output", () => {
  assert.equal(renderClaudeHooks(committed, operationCatalogTools), committed, "hooks/claude.json is stale; run: node scripts/generate-claude-hooks.mjs");
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
  assert.throws(() => renderClaudeHooks(JSON.stringify(reordered), operationCatalogTools), { code: "CLAUDE_HOOKS_SHAPE_UNEXPECTED" });
});

test("default tools/list and router-reachable tools follow the Session/effect matcher rule", () => {
  // A grouped tool (stage 3-F) is matched when any of its member operations is.
  const operations = new Map(operationCatalogTools.map((tool) => [tool.name, tool]));
  const rule = (tool) =>
    operationGroup(tool.name)
      ? operationGroup(tool.name).actions.some(({ operation }) => rule(operations.get(operation)))
      : resolveOperation(tool.name).router ||
        sessionCallRequiresBinding(tool.name) ||
        tool.annotations?.readOnlyHint !== true ||
        tool.name === "lode_conversation_list";
  // The native Hook helper is in no catalog, so every listed tool follows the rule.
  assert.ok([...toolsForSurface(), ...catalogTools, ...operationCatalogTools].every((tool) => tool.name !== "lode_session_host_request_prepare"));
  for (const tool of [...toolsForSurface(), ...catalogTools, ...operationCatalogTools]) {
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
      const group = operationGroup(name);
      assert.ok(operation || group, name);
      const canonical = operation?.canonicalName ?? group.name;
      assert.ok(names.includes(canonical) && names.includes(legacyOperationName(canonical)), name);
    }
    assert.equal(names.filter((name) => name.startsWith("lode_")).length * 2, names.length);
  }
});
