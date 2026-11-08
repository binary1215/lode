import assert from "node:assert/strict";
import test from "node:test";
import { canonicalOperationName, legacyOperationName } from "../compat/head/public-names.mjs";
import { OPERATION_DESCRIPTORS, resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

// Stage 3-D: the internal name of every operation is its canonical lode_* name.
// Historical head_* wire names stay accepted one way (head_* -> lode_*).

test("every operation's internal name is canonical and its head_* spelling resolves to it", () => {
  assert.equal(OPERATION_DESCRIPTORS.length, 147);
  for (const operation of OPERATION_DESCRIPTORS) {
    assert.match(operation.canonicalName, /^lode_[a-z0-9_]+$/);
    assert.equal(operation.semanticName, operation.canonicalName);
    assert.equal(operation.legacyName, legacyOperationName(operation.canonicalName));
    assert.equal(operation.legacyName, `head_${operation.suffix}`);
    assert.equal(resolveOperation(operation.legacyName), operation);
    assert.equal(resolveOperation(operation.canonicalName), operation);
  }
});

test("the alias rule is one way and never invents operations", () => {
  assert.equal(canonicalOperationName("head_project_status"), "lode_project_status");
  assert.equal(canonicalOperationName("lode_project_status"), "lode_project_status");
  assert.equal(canonicalOperationName("project_status"), "project_status");
  assert.equal(canonicalOperationName(null), null);
  assert.equal(resolveOperation("head_not_an_operation"), null);
  assert.equal(resolveOperation("lode_not_an_operation"), null);
  assert.equal(resolveOperation("HEAD_PROJECT_STATUS"), null);
});

test("MCP calls by a head_* name, directly or through the router, behave like the lode_* name", async () => {
  const call = async (name, args, id) => (await dispatch({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).result;
  const canonical = await call("lode_core_contract", {}, 1);
  const legacy = await call("head_core_contract", {}, 2);
  assert.deepEqual(legacy, canonical);
  const routedLegacy = await call("lode_tools_read", { name: "head_core_contract", arguments: {} }, 3);
  const routedLegacyRouter = await call("head_tools_read", { name: "lode_core_contract", arguments: {} }, 4);
  assert.deepEqual(routedLegacy, canonical);
  assert.deepEqual(routedLegacyRouter, canonical);
  const unknown = await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "head_not_an_operation", arguments: {} } });
  assert.equal(unknown.error.message, "Unknown tool: head_not_an_operation");
});
