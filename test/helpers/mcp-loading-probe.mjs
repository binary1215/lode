import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const loaded = [];
const preparedViewFailure = process.argv[2] === "prepared-view";
const hook = registerHooks({ load(url, context, nextLoad) {
  loaded.push(url);
  if (url.endsWith(preparedViewFailure ? "/lib/runtime-prepared-input-view.mjs" : "/lib/world-model.mjs")) throw new Error("SYNTHETIC_OPTIONAL_MODULE_UNAVAILABLE");
  return nextLoad(url, context);
} });
try {
  if (preparedViewFailure) {
    const [, , , root, authorizationId] = process.argv;
    const { runCommand } = await import("../../scripts/lode.mjs");
    const { dispatch } = await import("../../scripts/mcp-server.mjs");
    const cli = await runCommand(["runtime-invocation-read", root, "--authorization", authorizationId]);
    assert.equal(cli.status, "verified"); assert.equal(cli.authorization.authorizationId, authorizationId);
    assert.equal(cli.preparedInput.reasonCode, "PREPARED_INPUT_VIEW_UNAVAILABLE");
    const mcp = await dispatch({ id: "view-failure", method: "tools/call", params: { name: "head_runtime_invocation_authorization",
      arguments: { project_root: root, authorization_id: authorizationId } } });
    assert.equal(mcp.error, undefined); assert.equal(mcp.result.structuredContent.status, "verified");
    assert.equal(mcp.result.structuredContent.preparedInput.reasonCode, "PREPARED_INPUT_VIEW_UNAVAILABLE");
    console.log(JSON.stringify({ status: "pass", primaryAuthorizationPreserved: authorizationId, optionalViewFailureScoped: true,
      pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), ports: [], providerInvoked: false }));
  } else {
  const { dispatch } = await import("../../scripts/mcp-server.mjs");
  const call = (name, args = {}) => dispatch({ id: 1, method: "tools/call", params: { name, arguments: args } });
  const listed = await dispatch({ id: 0, method: "tools/list" });
  assert(!listed.error);
  assert(!(await call("head_core_contract")).error);
  assert(!(await call("head_tools_discover", { prefix: "head_world_" })).error);
  const cold = [...loaded];
  for (const file of ["world-model", "context-compiler", "bounded-worker-job", "bounded-worker-wave", "worker-integration-workflow", "product-operating-loop", "observation-adapter"]) {
    assert(!cold.some(url => url.endsWith(`/lib/${file}.mjs`)), file);
  }
  const unavailable = await call("head_tools_read", { name: "head_world_model", arguments: { project_root: "." } });
  assert.match(unavailable.error.message, /SYNTHETIC_OPTIONAL_MODULE_UNAVAILABLE/);
  assert(!(await call("head_core_contract")).error);
  assert(!(await dispatch({ id: 3, method: "tools/list" })).error);
  console.log(JSON.stringify({ status: "pass", pid: process.pid, parentPid: process.ppid,
    command: process.execPath, cwd: process.cwd(), ports: [], coldLoadedModules: cold.length,
    defaultTools: listed.result.tools.length, catalogBytes: Buffer.byteLength(JSON.stringify(listed.result.tools)),
    optionalFailureScoped: true, providerInvoked: false }));
  }
} finally { hook.deregister(); }
