import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

// The native Host Hook helper is not a catalog tool. A real stdio server keeps it
// out of tools/list, discovery and the routers, still accepts it from a Hook, and
// refuses a model's direct call with the native ingress codes (never "Unknown tool").
const pluginRoot = path.resolve(import.meta.dirname, "..");
const HELPER = "lode_session_host_request_prepare";

async function withServer(t, operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-hook-helper-unlisted-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 }));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const operational = path.join(root, "operational");
  const child = spawn(process.execPath, [path.join(pluginRoot, "scripts", "mcp-server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, LODE_AGENT_OPERATIONAL_STATE_ROOT: operational, HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    nextId = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  const rejectAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-16384);
  });
  child.once("error", rejectAll);
  lines.on("line", (line) => {
    const response = JSON.parse(line),
      entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code) => {
      rejectAll(new Error(`MCP server closed: ${code}; ${stderr}`));
      resolve(code);
    }),
  );
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP call timed out: ${method}`));
        }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "synthetic" } });
    return await operation(call, projectRoot);
  } finally {
    child.stdin.end();
    const force = setTimeout(() => child.kill(), 5000);
    await closed;
    clearTimeout(force);
    lines.close();
  }
}

const refusal = (code) => ({ content: [{ type: "text", text: `Native Host request correlation unavailable (${code}).` }], isError: true });

test("the native Hook helper is unlisted and undiscoverable, a Hook call still correlates, and a model call is refused", async (t) => {
  await withServer(t, async (call, projectRoot) => {
    // Not listed and not discoverable.
    const listed = (await call("tools/list", {})).result.tools.map((tool) => tool.name);
    assert.equal(listed.length, 22);
    assert.equal(listed.includes(HELPER), false);
    assert.equal(listed.includes("head_session_host_request_prepare"), false);
    const discovered = await call("tools/call", { name: "lode_tools_discover", arguments: { name: HELPER } });
    assert.match(discovered.error.message, /^Unknown or unavailable tool on ordinary: lode_session_host_request_prepare/);
    const page = (await call("tools/call", { name: "lode_tools_discover", arguments: { prefix: "lode_session", limit: 20 } })).result.structuredContent;
    assert.equal(
      page.tools.some((tool) => tool.name === HELPER),
      false,
    );

    // A model's direct call, under either spelling, is refused as before.
    for (const name of [HELPER, "head_session_host_request_prepare"]) {
      const direct = await call("tools/call", {
        name,
        arguments: { native_session_id: "forged", tool_use_id: "forged", outer_tool_name: "mcp__lode__lode_project_status", original_arguments: "{}" },
        _meta: { "claudecode/toolUseId": `model-${name}` },
      });
      assert.deepEqual(direct.result, refusal("NATIVE_HOOK_INGRESS_REQUIRED"), name);
    }
    // Through either router it is not a routable catalog entry.
    for (const router of ["lode_tools_read", "lode_tools_call"]) {
      const routed = await call("tools/call", {
        name: router,
        arguments: { name: HELPER, arguments: {} },
        _meta: { "claudecode/toolUseId": `model-${router}` },
      });
      assert.deepEqual(routed.result, refusal("NATIVE_HOOK_DIRECT_INGRESS_REQUIRED"), router);
    }

    // The Hook path (no model tool-use metadata) still prepares a correlation,
    // under the lode_* name and the head_* alias Hooks may send, and the matching
    // model call is served with it.
    const args = { project_root: projectRoot, profile: "core", runtimes: ["claude"] };
    for (const [hookName, toolUseId] of [
      ["head_session_host_request_prepare", "hook-alias"],
      [HELPER, "hook-canonical"],
    ]) {
      const prepared = await call("tools/call", {
        name: hookName,
        arguments: {
          native_session_id: "native-hook-unlisted",
          native_agent_id: null,
          tool_use_id: toolUseId,
          outer_tool_name: "mcp__lode__lode_project_initialize_or_resume",
          native_project_root: projectRoot,
          original_arguments: JSON.stringify(args),
        },
      });
      assert.deepEqual(prepared.result, { content: [{ type: "text", text: "{}" }] }, hookName);
    }
    const served = await call("tools/call", {
      name: "lode_project_initialize_or_resume",
      arguments: args,
      _meta: { "claudecode/toolUseId": "hook-canonical" },
    });
    assert.equal(served.result?.structuredContent?.projectAction, "initialized", JSON.stringify(served));
    assert.equal(served.result?.isError, undefined);
    // The Hook's correlation linked this native caller (no caller-unavailable fallback).
    assert.equal(served.result._meta?.headSessionBinding?.status, "host_selection_retained", JSON.stringify(served.result._meta));
  });
});
