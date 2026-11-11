import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { catalogTools, discoverTools, dispatch, operationCatalogTools, tools, toolsForSurface } from "../scripts/mcp-server.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import {
  DEPRECATED_ALIAS_REMOVAL_VERSION,
  OPERATION_GROUPS,
  effectiveToolCall,
  groupMembership,
  operationGroup,
  resolveGroupedCall,
} from "../scripts/lib/operation-groups.mjs";
import { legacyOperationName } from "../compat/head/public-names.mjs";
import { generateMcpSurfaceDocs } from "../scripts/generate-mcp-surface-docs.mjs";

// Stage 3-F (user decision 1 of 2026-11-08): grouped MCP tools, one per resource
// noun with an `action`, replace their member operations in the listed catalog.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const operations = new Map(operationCatalogTools.map((tool) => [tool.name, tool]));
const listed = new Map(catalogTools.map((tool) => [tool.name, tool]));
const call = (name, args, options = {}) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options);
const routed = (router, name, args, options) => call(router, { name, arguments: args }, options);

test("each grouped action is exactly one registered operation, never a default-list tool", () => {
  const defaults = new Set(tools.map((tool) => tool.name));
  const seen = new Set();
  for (const group of OPERATION_GROUPS) {
    assert.match(group.name, /^lode_[a-z_]+$/);
    assert.equal(resolveOperation(group.name), null, `${group.name} is not also an operation name`);
    assert.equal(operationGroup(legacyOperationName(group.name)), group);
    for (const { action, operation } of group.actions) {
      assert.equal(resolveOperation(operation)?.kind, "operation", operation);
      assert.ok(!seen.has(operation), `${operation} is in one group only`);
      seen.add(operation);
      assert.ok(!defaults.has(operation), `${operation} stays a default-list tool`);
      assert.deepEqual(groupMembership(operation), { group, action });
      assert.ok(!listed.has(operation), `${operation} is no longer listed`);
      assert.ok(operations.has(operation), `${operation} still dispatches`);
    }
    assert.ok(listed.has(group.name));
  }
  assert.equal(catalogTools.length, operationCatalogTools.length - seen.size + OPERATION_GROUPS.length);
  assert.equal(tools.length, 22);
  assert.equal(toolsForSurface("managed-maintenance").length, catalogTools.length + 3);
});

test("a grouped schema declares action and every member field, and each action keeps its own route", () => {
  for (const group of OPERATION_GROUPS) {
    const tool = listed.get(group.name);
    const members = group.actions.map(({ operation }) => operations.get(operation));
    assert.deepEqual(
      tool.inputSchema.properties.action.enum,
      group.actions.map((entry) => entry.action),
    );
    assert.equal(tool.inputSchema.required[0], "action");
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const field of tool.inputSchema.required.slice(1))
      assert.ok(
        members.every((member) => member.inputSchema.required.includes(field)),
        field,
      );
    for (const member of members) {
      for (const [field, schema] of Object.entries(member.inputSchema.properties)) {
        const declared = tool.inputSchema.properties[field];
        assert.ok(declared, `${group.name}.${field}`);
        assert.ok(JSON.stringify(declared) === JSON.stringify(schema) || declared.anyOf?.some((item) => JSON.stringify(item) === JSON.stringify(schema)));
      }
    }
    assert.equal(
      tool.annotations.readOnlyHint,
      members.every((member) => member.annotations.readOnlyHint === true),
    );
    // A grouped hint is never weaker than a member's, with MCP defaults for omitted
    // hints (destructiveHint true unless read-only, openWorldHint true).
    const destructive = (member) => member.annotations.readOnlyHint !== true && member.annotations.destructiveHint !== false;
    assert.equal(tool.annotations.destructiveHint, members.some(destructive), `${group.name} destructiveHint`);
    assert.equal(
      tool.annotations.openWorldHint,
      members.some((member) => member.annotations.openWorldHint !== false),
      `${group.name} openWorldHint`,
    );
    assert.equal(
      tool.annotations.idempotentHint,
      members.every((member) => member.annotations.idempotentHint === true),
      `${group.name} idempotentHint`,
    );
  }
});

test("a missing or unknown action is refused before any operation, in every spelling and route", async () => {
  for (const group of OPERATION_GROUPS) {
    for (const name of [group.name, legacyOperationName(group.name)]) {
      for (const args of [{ project_root: "/nowhere" }, { action: "unknown-action", project_root: "/nowhere" }, { action: 7 }]) {
        for (const response of [await call(name, args), await routed("lode_tools_call", name, args)]) {
          assert.equal(response.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(response));
          assert.match(response.error.message, /arguments\.action must be one of/);
        }
      }
    }
  }
  assert.throws(() => resolveGroupedCall("lode_bounded_worker_wave", null), { code: "INVALID_TOOL_ARGUMENTS" });
  assert.equal(resolveGroupedCall("lode_core_contract", {}), null);
  // Observers classify an invalid grouped call without failing it.
  assert.deepEqual(effectiveToolCall("lode_bounded_worker_wave", { action: "nope" }), { name: "lode_bounded_worker_wave", arguments: { action: "nope" } });
  assert.deepEqual(effectiveToolCall("head_bounded_worker_wave", { action: "seal", wave_id: "w" }), {
    name: "lode_bounded_worker_wave_seal",
    arguments: { wave_id: "w" },
  });
});

test("the read router keeps refusing effectful actions and accepts read-only ones", async () => {
  for (const group of OPERATION_GROUPS) {
    for (const { action, operation } of group.actions) {
      const readOnly = operations.get(operation).annotations.readOnlyHint === true;
      const args = { action, project_root: "/nowhere-lode-group-test" };
      const grouped = await routed("lode_tools_read", group.name, args);
      const alias = await routed("lode_tools_read", operation, { project_root: "/nowhere-lode-group-test" });
      assert.deepEqual(grouped, alias, `${group.name} ${action}`);
      if (!readOnly) assert.match(grouped.error.message, /not read-only/);
      else assert.doesNotMatch(JSON.stringify(grouped), /not read-only/);
    }
  }
});

test("a child's effectful grouped call gets the write-guard refusal even without a valid action", async () => {
  const group = OPERATION_GROUPS.find((entry) => listed.get(entry.name).annotations.readOnlyHint !== true);
  const response = await call(
    group.name,
    { project_root: "/nowhere" },
    { caller: { subagent: true }, hostEnvironment: { LODE_SUBAGENT_WRITE_GUARD: "enforce" } },
  );
  assert.match(response.error.message, /subagent|child|parent/i, JSON.stringify(response));
  assert.ok(response.error);
  assert.notEqual(response.error.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(response));
});

test("discovery lists grouped tools, finds them by their deprecated names, and keeps the old prefixes", () => {
  for (const group of OPERATION_GROUPS) {
    const byGroup = discoverTools({ name: group.name }).tools[0];
    assert.equal(byGroup.name, group.name);
    assert.deepEqual(
      byGroup.actions.map((entry) => entry.action),
      group.actions.map((entry) => entry.action),
    );
    for (const entry of byGroup.actions) {
      const operation = operations.get(group.actions.find((item) => item.action === entry.action).operation);
      assert.equal(entry.invokeWith, operation.annotations.readOnlyHint === true ? "lode_tools_read" : "lode_tools_call");
      assert.deepEqual(entry.required, operation.inputSchema.required ?? []);
      assert.equal(entry.description, operation.description);
    }
    assert.deepEqual(
      byGroup.deprecatedAliases,
      group.actions.map(({ action, operation }) => ({ name: operation, action, removedIn: DEPRECATED_ALIAS_REMOVAL_VERSION })),
    );
    for (const { operation } of group.actions) {
      for (const name of [operation, legacyOperationName(operation)]) assert.equal(discoverTools({ name }).tools[0].name, group.name, name);
      for (const prefix of [`${operation}_`, operation.slice(0, -1), legacyOperationName(operation)]) {
        assert.ok(
          discoverTools({ prefix, limit: 20 }).tools.some((tool) => tool.name === group.name),
          prefix,
        );
      }
    }
  }
  assert.equal(DEPRECATED_ALIAS_REMOVAL_VERSION, "0.5.0");
});

test("docs/mcp-surface.md (+ko) mapping tables are current", async () => {
  for (const result of await generateMcpSurfaceDocs({ root: pluginRoot, check: true })) assert.equal(result.status, "current", result.file);
});

test("the docs/mcp-surface.md (+ko) example call runs as written, and needs its execution_mode", async () => {
  for (const file of ["docs/mcp-surface.md", "docs/ko/mcp-surface.md"]) {
    const text = fs.readFileSync(path.join(pluginRoot, file), "utf8");
    const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
    const run = (args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: example.name, arguments: args } });
    const asWritten = await run(example.arguments);
    assert.notEqual(asWritten.error?.data?.reasonCode, "MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE", JSON.stringify(asWritten));
    assert.notEqual(asWritten.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(asWritten));
    const withoutMode = { ...example.arguments };
    delete withoutMode.execution_mode;
    const refused = await run(withoutMode);
    assert.equal(refused.error?.data?.reasonCode, "MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE", JSON.stringify(refused));
  }
});
