import assert from "node:assert/strict";
import test from "node:test";
import { dispatch, hostRuntimeOf } from "../scripts/mcp-server.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session/session-native-host.mjs";

// context.hostRuntime tells a registered operation which Host is calling:
// "codex" or "claude" as this server's native session bridge derived it, or
// null when Lode does not know. It is read from the bridge only; a tool input
// cannot set or override it.

const initialize = (clientName) => ({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: clientName, version: "0" } } });
const call = (name, args, options) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options);

test("the Host runtime is what the bridge derived from the MCP client, and null before or without it", async () => {
  for (const [client, expected] of [
    ["claude-code", "claude"],
    ["codex-mcp-client", "codex"],
    ["opencode", null],
    ["some-other-client", null],
  ]) {
    const bridge = createNativeSessionHostBridge({ environment: {} });
    assert.equal(hostRuntimeOf(bridge), null, "unknown before initialize");
    await bridge.dispatch(initialize(client), async () => ({}));
    assert.equal(hostRuntimeOf(bridge), expected, client);
  }
  assert.equal(hostRuntimeOf(createNativeSessionHostBridge({ runtime: "claude", environment: {} })), "claude");
  assert.equal(hostRuntimeOf(null), null);
  assert.equal(hostRuntimeOf(undefined), null);
});

test("only the two runtimes the bridge can derive pass; anything else is null, never a guess", () => {
  const describing = (runtime) => ({ describe: () => ({ runtime }) });
  assert.equal(hostRuntimeOf(describing("codex")), "codex");
  assert.equal(hostRuntimeOf(describing("claude")), "claude");
  for (const runtime of ["opencode", "Claude", "claude-code", "", null, undefined, 1, {}])
    assert.equal(hostRuntimeOf(describing(runtime)), null, String(runtime));
  assert.equal(hostRuntimeOf({}), null, "a bridge without describe");
});

test("a tool input cannot name the Host runtime: the field is refused before any operation runs", async () => {
  // A bridge that passes every call through, describing a Claude Host.
  const bridge = { describe: () => ({ runtime: "claude" }), dispatch: (request, handler) => handler(request, {}) };
  // The prepare operation is managed: called directly on the managed-maintenance
  // surface, or through lode_tools_call with execution_mode managed.
  const managed = { nativeSessionBridge: bridge, surface: "managed-maintenance" };
  const prepare = { project_root: "unused-root", task: "t", model: "claude-test" };
  for (const field of ["hostRuntime", "host_runtime"]) {
    const direct = await call("lode_bounded_worker_prepare", { ...prepare, [field]: "codex" }, managed);
    assert.equal(direct.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(direct));
    assert.match(direct.error.message, new RegExp(field));

    const grouped = await call("lode_bounded_worker", { action: "prepare", ...prepare, [field]: "codex" }, managed);
    assert.equal(grouped.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(grouped));
    assert.match(grouped.error.message, new RegExp(field));

    const routed = await call(
      "lode_tools_call",
      { name: "lode_bounded_worker_prepare", execution_mode: "managed", arguments: { ...prepare, [field]: "codex" } },
      { nativeSessionBridge: bridge },
    );
    assert.equal(routed.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(routed));
    assert.match(routed.error.message, new RegExp(field));
  }
});
