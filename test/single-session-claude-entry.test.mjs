import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { createHeadSession, projectHasSingleSession } from "../scripts/lib/session/session-routing.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session/session-host-adapter.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session/session-host-request.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";

// beta.118: a new Claude Code conversation in a Project with exactly one
// Session gets that Session's saved direction from one lode_conversation_enter
// call. Nothing is bound; several Sessions and non-absent bindings keep their
// previous answer.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const purpose = "Fix the login failure";

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-single-session-")));
  const root = path.join(base, "project"),
    operational = path.join(base, "host");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational, LODE_SUBAGENT_WRITE_GUARD: "off" };
  // Save a direction through an unverified MCP caller (the Project default).
  const plain = async (name, args = {}) => {
    const response = await dispatch({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  };
  const basis = await plain("lode_checkpoint_basis");
  await plain("lode_checkpoint_sync", {
    expected_recovery_basis_id: basis.basis.basisId,
    purpose,
    approved_decisions: ["Keep the existing login contract"],
    current_position: "Cause identified; fix pending",
    next_expected_result: "Login regression test passes",
  });
  const bridge = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => bridge.dispose());
  let toolUse = 0;
  // A Claude Code call; `prepared: false` skips the PreToolUse hook preparation.
  const claude = async (nativeSessionId, name, args = {}, { prepared = true } = {}) => {
    const id = `tool-use-${++toolUse}`;
    const wire = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _meta: { "claudecode/toolUseId": id }, name, arguments: { project_root: root, ...args } },
    };
    if (prepared) {
      const hook = await dispatch(
        {
          jsonrpc: "2.0",
          id: `${id}-hook`,
          method: "tools/call",
          params: {
            name: SESSION_HOST_REQUEST_HELPER,
            arguments: {
              native_session_id: nativeSessionId,
              native_agent_id: "",
              tool_use_id: id,
              outer_tool_name: `mcp__lode__${name}`,
              original_arguments: JSON.stringify(wire.params.arguments),
            },
          },
        },
        { nativeSessionBridge: bridge },
      );
      assert.equal(hook.result?.isError, undefined, JSON.stringify(hook));
    }
    return (await dispatch(wire, { nativeSessionBridge: bridge })).result;
  };
  const adapter = (nativeSessionId) => createSessionHostAdapter({ runtime: "claude", nativeSessionId, environment });
  const start = async (nativeSessionId, runtime = "claude") =>
    JSON.parse(
      (
        await sessionStartContext({
          runtime,
          event: { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: nativeSessionId },
          environment,
        })
      ).hookSpecificOutput?.additionalContext ?? "{}",
    );
  return { root, operational, environment, claude, adapter, start, defaultSessionId: inspectProject(root).state.sessionId };
}
const tree = (directory) =>
  fs.existsSync(directory)
    ? fs
        .readdirSync(directory, { recursive: true })
        .filter((entry) => fs.statSync(path.join(directory, entry)).isFile())
        .sort()
        .map((entry) => [entry, fs.readFileSync(path.join(directory, entry), "utf8")])
    : [];

test("single Session: a verified caller with no binding gets the saved direction and nothing is bound", async (t) => {
  const { root, operational, claude, adapter, defaultSessionId } = await fixture(t);
  assert.equal(projectHasSingleSession(root), true);
  const before = tree(root).concat(tree(operational));
  const entered = await claude("new-chat", "lode_conversation_enter");
  assert.equal(entered.structuredContent.status, "conversation_direction_restored");
  assert.match(JSON.stringify(entered.structuredContent), new RegExp(purpose));
  assert.equal(entered.structuredContent.workContext?.sessionId ?? entered.structuredContent.sessionId, defaultSessionId);
  assert.equal(adapter("new-chat").read({ root }).status, "absent", "no binding is written");
  assert.deepEqual(tree(root).concat(tree(operational)), before, "a read-only entry writes nothing");
});

test("single Session: a call the PreToolUse hook did not prepare gets the saved direction and claims no binding", async (t) => {
  const { root, operational, claude, defaultSessionId } = await fixture(t);
  const before = tree(root).concat(tree(operational));
  const entered = await claude("unprepared-chat", "lode_conversation_enter", {}, { prepared: false });
  assert.equal(entered.structuredContent.status, "conversation_direction_restored");
  assert.match(JSON.stringify(entered.structuredContent), new RegExp(purpose));
  assert.equal(entered.structuredContent.workContext?.sessionId ?? entered.structuredContent.sessionId, defaultSessionId);
  assert.equal(entered._meta.headSessionBinding.status, "unavailable");
  assert.equal(entered._meta.headSessionBinding.persisted, false);
  assert.deepEqual(tree(root).concat(tree(operational)), before);
});

test("several Sessions: both paths stay unresolved and leave the choice to the user", async (t) => {
  const { root, claude, start } = await fixture(t);
  createHeadSession({ root, purpose: "Another task" });
  assert.equal(projectHasSingleSession(root), false);
  const verified = (await claude("several-verified", "lode_conversation_enter")).structuredContent;
  assert.equal(verified.status, "session_selection_unresolved");
  assert.equal(verified.reasonCode, "SESSION_SELECTION_LOST");
  assert.equal(verified.sessionDiscovery.call.name, "lode_session_list");
  const unprepared = (await claude("several-unprepared", "lode_conversation_enter", {}, { prepared: false })).structuredContent;
  assert.equal(unprepared.status, "session_selection_unresolved");
  assert.equal(unprepared.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE");
  const hook = await start("several-hook");
  assert.equal(hook.status, "session_selection_unresolved");
  assert.equal(hook.reasonCode, "SESSION_SELECTION_LOST");
  assert.equal(hook.sessionDiscovery.call.name, "lode_session_list");
});

test("single Session: pending, lost and corrupt bindings keep their previous answer", async (t) => {
  const { root, operational, claude, adapter, defaultSessionId } = await fixture(t);
  for (const status of ["pending", "lost", "corrupt"]) {
    const caller = `claude-${status}`,
      host = adapter(caller);
    if (status === "pending") host.prepareSelection({ root, sessionId: defaultSessionId });
    else {
      host.select({ root, sessionId: defaultSessionId, expectedRevision: 0 });
      if (status === "lost") host.lose({ root, expectedRevision: 1 });
      else {
        const digest = host.read({ root }).bindingDigest;
        const file = fs
          .readdirSync(operational, { recursive: true })
          .map((relative) => path.join(operational, relative))
          .find((file) => file.endsWith("binding.json") && JSON.parse(fs.readFileSync(file, "utf8")).bindingDigest === digest);
        fs.writeFileSync(file, "{corrupt synthetic binding");
      }
    }
    const entered = await claude(caller, "lode_conversation_enter");
    assert.equal(entered.structuredContent.status, "session_selection_unresolved", status);
  }
});

test("Hook state, Skill row and one entry call: the saved direction comes back from lode_conversation_enter alone", async (t) => {
  const { claude, start } = await fixture(t);
  const hook = await start("hook-chat");
  // The Hook still selects nothing.
  assert.equal(hook.status, "session_selection_unresolved");
  assert.equal(hook.logicalSessionId, null);
  assert.equal(hook.reasonCode, "SINGLE_SESSION_ENTRY_AVAILABLE");
  assert.equal(hook.sessionDiscovery.call.name, "lode_conversation_enter");
  // The Skill entry table has the row this state selects, naming the same call.
  const skill = fs.readFileSync(path.join(pluginRoot, "skills/lode-agent-core/SKILL.md"), "utf8");
  const row = skill.split("\n").find((line) => line.startsWith("| `session_selection_unresolved` + `reasonCode: SINGLE_SESSION_ENTRY_AVAILABLE`"));
  assert.ok(row, "Skill entry row for the single-Session state");
  assert.match(row, /`lode_conversation_enter`/);
  // Following it is one call.
  const { project_root: _root, ...args } = hook.sessionDiscovery.call.arguments;
  const entered = await claude("hook-chat", hook.sessionDiscovery.call.name, args);
  assert.equal(entered.structuredContent.status, "conversation_direction_restored");
  assert.match(JSON.stringify(entered.structuredContent), new RegExp(purpose));
});

test("Codex and OpenCode startup context is unchanged in a single-Session Project", async (t) => {
  const { root, environment, start } = await fixture(t);
  const codex = await start("codex-thread", "codex");
  assert.notEqual(codex.reasonCode, "SINGLE_SESSION_ENTRY_AVAILABLE");
  const opencode = createSessionHostAdapter({ runtime: "opencode", nativeSessionId: "ses_single", environment });
  const entered = await opencode.enter({ root });
  assert.equal(entered.status, "session_selection_unresolved");
  assert.equal(entered.reasonCode, "SESSION_SELECTION_LOST");
  assert.equal(entered.sessionDiscovery.call.name, "lode_session_list");
});
