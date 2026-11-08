import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import plugin from "../scripts/opencode-plugin.mjs";
import { createNativeObservationStore } from "../scripts/lib/native-session-observations.mjs";
import { buildCodexMarketplaceSnapshot } from "../scripts/lib/codex-marketplace.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const caller = { runtime: "opencode", nativeSessionId: "ses_fixture", agentId: null };
const snapshot = (root) =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true })
        .filter((p) => fs.statSync(path.join(root, p)).isFile())
        .sort()
        .map((p) => [p, fs.readFileSync(path.join(root, p), "utf8")])
    : [];
async function fixture(t, overrides = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-opencode-v1-"))),
    root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["opencode"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "operational") },
    calls = { get: [], status: [] };
  const client = {
    session: {
      async get(input) {
        calls.get.push(input);
        return { data: { id: caller.nativeSessionId, projectID: "host-project", directory: root, ...overrides.session } };
      },
      async status(input) {
        calls.status.push(input);
        return { data: overrides.map || {} };
      },
    },
  };
  const hooks = await plugin.server({ client, project: { id: "host-project" }, directory: root }, { environment });
  t.after(() => hooks.dispose());
  const config = { mcp: { my_head: { type: "local", command: ["node", path.join(pluginRoot, "scripts/mcp-server.mjs")] } } };
  await hooks.config(config);
  const input = { tool: "my_head_head_project_status", sessionID: caller.nativeSessionId, callID: "call_exact", args: { project_root: root } };
  const raw = async () => (await dispatch({ id: 1, method: "tools/call", params: { name: "head_project_status", arguments: { project_root: root } } })).result;
  return { root, base, environment, hooks, calls, client, config, input, raw };
}
// Pinned Plugin.trigger ignores the callback return; tests use the actual object.
async function after(hooks, input, output) {
  await hooks["tool.execute.after"](input, output);
  return output;
}

test("portable OpenCode placeholder resolves to this package only in the loaded config object", async (t) => {
  const f = await fixture(t);
  const config = { mcp: { lode: { type: "local", command: ["node", "{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs"], enabled: true } } };
  await f.hooks.config(config);
  assert.equal(path.basename(config.mcp.lode.command[0]), "node");
  assert.equal(fs.realpathSync(config.mcp.lode.command[1]), fs.realpathSync(path.join(pluginRoot, "scripts/mcp-server.mjs")));
  assert.equal(fs.readFileSync(path.join(f.root, "opencode.json"), "utf8").includes(pluginRoot), false);
});

test("staged .js V1 default loader -> config/event -> shared writer -> raw MCP actual output text+structured", async (t) => {
  const f = await fixture(t, { map: { [caller.nativeSessionId]: { type: "busy" } } });
  const directory = path.join(f.base, ".opencode", "plugins");
  fs.mkdirSync(directory, { recursive: true });
  const packageRoot = path.join(f.base, "staged-marketplace");
  const built = buildCodexMarketplaceSnapshot({ sourceRoot: pluginRoot, outputRoot: packageRoot, repository: "local", commit: "local" });
  const packagedEntry = path.join(packageRoot, "plugins", built.pluginName, "scripts/opencode-plugin.mjs");
  const shim = path.join(directory, "head-agent.js");
  fs.writeFileSync(shim, `export {default} from ${JSON.stringify(pathToFileURL(packagedEntry).href)};\n`);
  assert.deepEqual(
    fs.readdirSync(directory).filter((x) => /\.(js|ts)$/u.test(x)),
    ["head-agent.js"],
  );
  const loaded = await import(pathToFileURL(shim).href);
  assert.deepEqual(Object.keys(loaded), ["default"]);
  assert.equal(typeof loaded.default.server, "function");
  f.hooks = await loaded.default.server({ client: f.client, project: { id: "host-project" }, directory: f.root }, { environment: f.environment });
  t.after(() => f.hooks.dispose());
  await f.hooks.config({ mcp: { my_head: { type: "local", command: ["node", path.join(path.dirname(packagedEntry), "mcp-server.mjs")] } } });
  await f.hooks.event({ event: { id: "evt1", type: "session.created", properties: { info: { id: caller.nativeSessionId } } } });
  const canonical = snapshot(f.root),
    operational = snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT);
  const output = await f.raw(),
    before = structuredClone(output),
    same = await after(f.hooks, f.input, output);
  assert.equal(same, output);
  assert.deepEqual(output.content.slice(0, before.content.length), before.content);
  const { nativeContext, ...original } = output.structuredContent;
  assert.deepEqual(original, before.structuredContent);
  assert.deepEqual(JSON.parse(output.content.at(-1).text.split("\n").slice(1).join("\n")), nativeContext);
  assert.equal(nativeContext.currentObservation.state, "busy");
  assert.equal(nativeContext.caller.nativeSessionId, caller.nativeSessionId);
  assert.equal(f.calls.status.length, 1);
  assert.equal(f.calls.get.at(-1).path.id, caller.nativeSessionId);
  assert.deepEqual(snapshot(f.root), canonical);
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), operational);
});

test("empty/reset status map is not ended; exact router status is supported without a second observer", async (t) => {
  const f = await fixture(t);
  const output = await f.raw();
  await after(f.hooks, { ...f.input, tool: "my_head_head_tools_read", args: { name: "head_project_status", arguments: f.input.args } }, output);
  assert.equal(output.structuredContent.nativeContext.currentObservation.state, "no-non-idle-entry");
  assert.equal(f.calls.status.length, 1);
  assert.equal(fs.existsSync(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), false);
});

test("event replay/different same-ID payload is bounded; free-form errors and dispose produce no instructions/end", async (t) => {
  const f = await fixture(t),
    store = createNativeObservationStore({ environment: f.environment });
  const input = {
    event: { id: "same-id", type: "session.status", properties: { sessionID: caller.nativeSessionId, status: { type: "busy", message: "SECRET" } } },
  };
  await f.hooks.event(input);
  const before = snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT);
  await f.hooks.event(input);
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), before);
  await f.hooks.event({ event: { ...input.event, properties: { ...input.event.properties, status: { type: "retry" } } } });
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), before);
  const state = store.read({ root: f.root, caller });
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
  await f.hooks.dispose();
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), before);
});

test("delivered exact deletion survives post-delete get404 without looking up the vanished Session", async (t) => {
  const f = await fixture(t),
    store = createNativeObservationStore({ environment: f.environment });
  f.client.session.get = async (input) => {
    f.calls.get.push(input);
    return { error: { status: 404 } };
  };
  const delivered = {
    event: {
      id: "actual-deleted",
      type: "session.deleted",
      properties: { sessionID: caller.nativeSessionId, info: { id: caller.nativeSessionId, projectID: "host-project", directory: f.root, title: "SECRET" } },
    },
  };
  const canonical = snapshot(f.root);
  await f.hooks.event(delivered);
  const state = store.read({ root: f.root, caller });
  assert.ok(state, "A delivered exact owner-scoped deletion must not require the deleted record to remain gettable.");
  assert.equal(state.rows[0].observation.phase, "caller-deleted-observed");
  assert.equal(JSON.stringify(state).includes("SECRET"), false);
  assert.equal(f.calls.get.length, 0);
  const before = snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT);
  await f.hooks.event(delivered);
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), before);
  await f.hooks.event({ event: { id: "non-deleted-404", type: "session.idle", properties: { sessionID: caller.nativeSessionId } } });
  assert.equal(f.calls.get.length, 1);
  assert.deepEqual(snapshot(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), before);
  assert.deepEqual(snapshot(f.root), canonical);
});

test("deletion missing/mismatched owner info stays unknown; get404 is never itself deletion evidence", async (t) => {
  const f = await fixture(t),
    valid = { id: caller.nativeSessionId, projectID: "host-project", directory: f.root };
  for (const info of [null, { ...valid, id: "other" }, { ...valid, projectID: "other" }, { ...valid, directory: path.parse(f.root).root }]) {
    await f.hooks.event({
      event: { id: "bad-deletion", type: "session.deleted", properties: { sessionID: caller.nativeSessionId, ...(info ? { info } : {}) } },
    });
  }
  assert.equal(fs.existsSync(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), false);
  assert.equal(f.calls.get.length, 0);
});

test("config-proven alias only; sanitized collision/remote/other tool skip unchanged and make no SDK status call", async (t) => {
  const f = await fixture(t);
  const local = f.config.mcp.my_head;
  for (const config of [
    { mcp: { my_head: { type: "remote", url: "https://example.invalid" } } },
    { mcp: { "my.head": local, my_head: local } },
    { mcp: { my_head: { type: "local", command: ["node", "somewhere/scripts/mcp-server.mjs"] } } },
  ]) {
    await f.hooks.config(config);
    const output = await f.raw(),
      before = structuredClone(output);
    await after(f.hooks, f.input, output);
    assert.deepEqual(output, before);
  }
  assert.equal(f.calls.status.length, 0);
  await f.hooks.config(f.config);
  const output = await f.raw(),
    before = structuredClone(output);
  await after(f.hooks, { ...f.input, tool: "my_head_head_tools_call", args: { name: "head_session_list", arguments: f.input.args } }, output);
  assert.deepEqual(output, before);
});

test("wrong exact Session/project/directory never attaches activity to logical HEAD or creates observations", async (t) => {
  for (const session of [{ id: "wrong" }, { projectID: "other-project" }, { directory: path.parse(pluginRoot).root }]) {
    const f = await fixture(t, { session }),
      output = await f.raw(),
      before = structuredClone(output);
    await after(f.hooks, f.input, output);
    assert.deepEqual(output, before);
    assert.equal(f.calls.status.length, 0);
    await f.hooks.event({ event: { id: "wrong", type: "session.idle", properties: { sessionID: caller.nativeSessionId } } });
    assert.equal(fs.existsSync(f.environment.HEAD_AGENT_OPERATIONAL_STATE_ROOT), false);
  }
});

test("frozen/error/malformed raw responses and missing actual callID are untouched", async (t) => {
  const f = await fixture(t);
  const variants = [
    Object.freeze(await f.raw()),
    { ...(await f.raw()), isError: true },
    { content: [{ type: "text", text: "raw unsupported output" }] },
    { ...(await f.raw()), content: null },
  ];
  for (const output of variants) {
    const before = structuredClone(output);
    await after(f.hooks, f.input, output);
    assert.deepEqual(output, before);
  }
  const output = await f.raw(),
    before = structuredClone(output);
  await after(f.hooks, { ...f.input, callID: undefined }, output);
  assert.deepEqual(output, before);
  assert.equal(f.calls.status.length, 0);
});

test("large/error/timeout supplied map remains scoped unknown, one lookup, no gate or SDK recreation", async (t) => {
  const f = await fixture(t, { map: { enormous: "x".repeat(70 * 1024) } });
  let output = await f.raw();
  await after(f.hooks, f.input, output);
  assert.equal(output.structuredContent.nativeContext.currentObservation.state, "unknown");
  assert.equal(f.calls.status.length, 1);
  let cancelled = false;
  f.client.session.status = ({ signal }) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () => {
        cancelled = true;
        resolve({ error: "cancelled" });
      }),
    );
  output = await f.raw();
  const start = Date.now();
  await after(f.hooks, f.input, output);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - start < 1500);
  assert.equal(output.structuredContent.nativeContext.currentObservation.state, "unknown");
  assert.equal(output.isError, undefined);
});
