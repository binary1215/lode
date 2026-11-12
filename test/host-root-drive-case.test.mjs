import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session/session-host-request.mjs";
import { createNativeObservationStore, projectNativeObservations } from "../scripts/lib/session/native-session-observations.mjs";
import { prepareUserPromptReference } from "../scripts/lib/session/user-prompt-reference.mjs";
import { withRecordedCwd } from "../scripts/lib/storage/project-root-spelling.mjs";
import { runSessionHostHook, sessionStartContext } from "../scripts/session-host-hook.mjs";
import plugin from "../scripts/opencode-plugin.mjs";
import { deliverQueuedOpenCode, registerOpenCodePresence, writeOpenCodeCallerTicket } from "../scripts/lib/session/conversation-messaging.mjs";

// The root a Host hands to its hooks (Claude/Codex `cwd`, OpenCode `directory`,
// the `${cwd}` the Claude PreToolUse template passes as native_project_root)
// reaches the Project recorded with the upper-case drive letter when only the
// drive-letter case differs (Windows only). Nothing stored is rewritten.

const windows = process.platform === "win32";
const onWindows = { skip: windows ? false : "drive letters exist only on Windows" };
const pluginRoot = path.resolve(import.meta.dirname, "..");
const lower = (root) => root[0].toLowerCase() + root.slice(1);

function fixture(t, runtimes = ["claude", "codex"]) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lode-host-drive-case-")));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"), LODE_SUBAGENT_WRITE_GUARD: "off" };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, environment };
}
const projectTree = (root) =>
  fs
    .readdirSync(path.join(root, ".lode"), { recursive: true })
    .filter((entry) => fs.statSync(path.join(root, ".lode", entry)).isFile())
    .sort()
    .map((entry) => [entry, fs.readFileSync(path.join(root, ".lode", entry), "utf8")]);
const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";

test("off Windows and for an unchanged spelling the hook event is passed on as given", () => {
  const event = { hook_event_name: "Stop", cwd: "c:\\anything", session_id: "s" };
  assert.equal(withRecordedCwd(event, { platform: "linux" }), event);
  assert.equal(withRecordedCwd(null), null);
  const noCwd = { hook_event_name: "Stop" };
  assert.equal(withRecordedCwd(noCwd), noCwd);
});

test("Claude SessionStart: a lower-case drive in cwd enters the recorded Project instead of reporting relocation", onWindows, async (t) => {
  const { root, environment } = fixture(t);
  assert.match(root, /^[A-Z]:/);
  const before = projectTree(root);
  const event = (cwd, session) => ({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: session });
  const fromLower = context(await sessionStartContext({ runtime: "claude", event: event(lower(root), "native-lower"), environment }));
  const fromUpper = context(await sessionStartContext({ runtime: "claude", event: event(root, "native-upper"), environment }));
  assert.doesNotMatch(fromLower, /PROJECT_RELOCATION_AVAILABLE|host_context_unavailable/);
  assert.doesNotMatch(fromUpper, /host_context_unavailable/);
  // The same projection apart from the native caller it was rendered for.
  assert.equal(fromLower.replaceAll("native-lower", "X"), fromUpper.replaceAll("native-upper", "X"));
  // The full hook path (as the command hook runs it) answers the same way.
  const full = context(await runSessionHostHook({ runtime: "claude", event: event(lower(root), "native-full"), environment }));
  assert.doesNotMatch(full, /PROJECT_RELOCATION_AVAILABLE|host_context_unavailable/);
  assert.deepEqual(projectTree(root), before, "the Project's stored records are not rewritten");
});

test("prompt, stop and PreCompact observations from a lower-case cwd are kept under the recorded Project", onWindows, async (t) => {
  const { root, environment } = fixture(t);
  const caller = { runtime: "codex", nativeSessionId: "thread-lower", agentId: null };
  const hook = (name, more = {}) =>
    runSessionHostHook({
      runtime: "codex",
      observeOnly: true,
      environment,
      event: { hook_event_name: name, cwd: lower(root), session_id: caller.nativeSessionId, ...more },
    });
  await hook("UserPromptSubmit", { turn_id: "turn-prompt", prompt: "Keep this request" });
  await hook("Stop", { turn_id: "turn-stop", last_assistant_message: "Done" });
  await hook("PreCompact", { trigger: "manual" });
  const projection = JSON.stringify(await projectNativeObservations({ root, caller, environment }));
  assert.match(projection, /turn-prompt/);
  assert.match(projection, /turn-stop/);
  // The prompt reference was captured for the recorded root as well.
  const reference = prepareUserPromptReference({ root, ...caller, environment, force: true, additionalContext: "", limit: 100_000 });
  assert.match(reference?.text ?? "", /Keep this request/);
});

test("PreToolUse native_project_root: a lower-case ${cwd} reaches the server in the recorded spelling", onWindows, async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => bridge.dispose());
  const args = { project_root: root };
  const prepared = await bridge.dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: SESSION_HOST_REQUEST_HELPER,
        arguments: {
          native_session_id: "native-pretool",
          native_agent_id: "",
          tool_use_id: "tool-use-lower",
          outer_tool_name: "mcp__lode__lode_project_initialize_or_resume",
          original_arguments: JSON.stringify(args),
          native_project_root: lower(root),
        },
      },
    },
    () => assert.fail("the helper is answered by the bridge"),
  );
  assert.equal(prepared.result.isError, undefined, JSON.stringify(prepared));
  let installationCaller;
  await bridge.dispatch(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { _meta: { "claudecode/toolUseId": "tool-use-lower" }, name: "lode_project_initialize_or_resume", arguments: args },
    },
    (request, route) => {
      installationCaller ??= route.installationCaller;
      return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "{}" }] } };
    },
  );
  assert.equal(installationCaller?.nativeProjectRoot, root);
});

test("OpenCode: a lower-case directory delivers the recorded Project's context and keeps its observations", onWindows, async (t) => {
  const { root, environment } = fixture(t, ["opencode"]);
  const directory = lower(root);
  const sessionID = "ses_lower";
  const client = {
    session: {
      get: async () => ({ data: { id: sessionID, projectID: "host-project", directory } }),
      status: async () => ({ data: {} }),
    },
  };
  const hooks = await plugin.server({ client, project: { id: "host-project" }, directory }, { environment });
  t.after(() => hooks.dispose());
  const before = projectTree(root);
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, output);
  const delivered = output.system.join("\n");
  assert.ok(delivered.length > 0);
  assert.doesNotMatch(delivered, /optional request context unavailable/);
  await hooks.event({ event: { id: "evt-1", type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
  const caller = { runtime: "opencode", nativeSessionId: sessionID, agentId: null };
  assert.match(JSON.stringify(await projectNativeObservations({ root, caller, environment })), /busy/);
  assert.deepEqual(projectTree(root), before, "the Project's stored records are not rewritten");
});

test("a moved Project is still reported as relocated to SessionStart, in either drive-letter case", onWindows, async (t) => {
  const { base, root, environment } = fixture(t);
  const moved = path.join(base, "moved");
  fs.renameSync(root, moved);
  for (const cwd of [moved, lower(moved)]) {
    const output = context(
      await sessionStartContext({ runtime: "claude", event: { hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" }, environment }),
    );
    assert.match(output, /PROJECT_RELOCATION_AVAILABLE/, cwd);
  }
});

test("a Project recorded with a lower-case drive letter keeps today's rule for hooks", onWindows, async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lode-host-drive-case-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = lower(path.join(base, "project"));
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host") };
  const start = async (cwd) =>
    context(await sessionStartContext({ runtime: "claude", event: { hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" }, environment }));
  assert.doesNotMatch(await start(root), /host_context_unavailable/);
  // The upper-case spelling is never looked up, so it is the relocation it was before.
  assert.match(await start(root[0].toUpperCase() + root.slice(1)), /PROJECT_RELOCATION_AVAILABLE/);
});

test("Codex fork and parent links survive a lower-case cwd in the hook and in the transcript header", onWindows, async (t) => {
  const { base, root, environment } = fixture(t);
  const transcript = path.join(base, "child.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      timestamp: "2026-11-12T00:00:00Z",
      type: "session_meta",
      payload: { id: "child", session_id: "child", cwd: lower(root), cli_version: "0.0.0", source: "cli", forked_from_id: "parent" },
    }) + "\n",
  );
  await runSessionHostHook({
    runtime: "codex",
    observeOnly: true,
    environment,
    event: { hook_event_name: "SessionStart", source: "fork", cwd: lower(root), session_id: "child", transcript_path: transcript },
  });
  const caller = { runtime: "codex", nativeSessionId: "child", agentId: null };
  const rows = createNativeObservationStore({ environment }).read({ root, caller }).rows;
  assert.deepEqual(
    rows.filter((row) => row.observation.kind === "edge").map((row) => row.observation.edge.relation),
    ["native-fork"],
  );
});

test("OpenCode messaging: a lower-case session directory registers presence, gets a caller ticket and is delivered to", onWindows, async (t) => {
  const { root, environment } = fixture(t, ["opencode"]);
  const session = { id: "ses_lower", directory: lower(root) };
  assert.ok(registerOpenCodePresence({ root, session, client: {}, environment }), "presence registered");
  assert.ok(writeOpenCodeCallerTicket({ root, session, args: { body: "x" }, environment }), "caller ticket written");
  // Delivery opens the recorded Project; the OpenCode client keeps the Host directory.
  assert.deepEqual(await deliverQueuedOpenCode({ root, client: {}, directory: lower(root), environment }), []);
});
