import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session-host-request.mjs";
import { createRecoveryBasisMemory } from "../scripts/lib/recovery-basis-memory.mjs";
import { recordedRootSpelling, sameExceptDriveCase, sameRootSpelling, withRecordedProjectRoot } from "../scripts/lib/project-root-spelling.mjs";
import { createNativeObservationStore, normalizeNativeHook } from "../scripts/lib/native-session-observations.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

// A project_root that differs from the recorded root only in drive-letter case
// is the same Project in every MCP and CLI operation (Windows only). Nothing is
// written because of the spelling, and a moved Project is still relocated.

const windows = process.platform === "win32";
const onWindows = { skip: windows ? false : "drive letters exist only on Windows" };
const pluginRoot = path.resolve(import.meta.dirname, "..");
const flip = (root) => (root[0] === root[0].toUpperCase() ? root[0].toLowerCase() : root[0].toUpperCase()) + root.slice(1);
const direction = { purpose: "Same Project", approved_decisions: [], current_position: "Tests", next_expected_result: "Green" };

function fixture(t, { spell = (root) => root } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lode-drive-case-")));
  const root = spell(path.join(base, "project"));
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"), LODE_SUBAGENT_WRITE_GUARD: "off" };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, environment };
}
function snapshot(directory) {
  return fs
    .readdirSync(directory, { recursive: true })
    .filter((entry) => fs.statSync(path.join(directory, entry)).isFile())
    .sort()
    .map((entry) => [entry, fs.readFileSync(path.join(directory, entry), "utf8")]);
}
const request = (root, name, args = {}, meta) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { ...(meta ? { _meta: meta } : {}), name, arguments: { project_root: root, ...args } },
});
const value = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
};

test("the drive-letter comparison is exact apart from the drive letter, and only on Windows", () => {
  assert.equal(sameExceptDriveCase("C:\\work\\p", "c:\\work\\p"), true);
  assert.equal(sameExceptDriveCase("C:\\work\\p", "C:\\work\\p"), false);
  assert.equal(sameExceptDriveCase("C:\\work\\p", "c:\\Work\\p"), false);
  assert.equal(sameExceptDriveCase("C:\\work\\p", "D:\\work\\p"), false);
  assert.equal(sameExceptDriveCase("/c/work", "/C/work"), false);
  assert.equal(sameRootSpelling("C:\\p", "c:\\p", { platform: "win32" }), true);
  assert.equal(sameRootSpelling("C:\\p", "c:\\p", { platform: "linux" }), false);
  assert.equal(sameRootSpelling("/p", "/p", { platform: "linux" }), true);
  // Off Windows the requested spelling is always kept as given.
  assert.equal(recordedRootSpelling("c:\\anything", { platform: "linux" }), "c:\\anything");
  const plain = request("x", "lode_project_status");
  assert.equal(withRecordedProjectRoot(plain, { platform: "linux" }), plain);
});

test("off Windows a Project root is read exactly as given (behaviour unchanged)", { skip: windows ? "covered by the Windows tests" : false }, (t) => {
  const { root } = fixture(t);
  assert.equal(recordedRootSpelling(root), root);
  const call = request(root, "lode_project_status");
  assert.equal(withRecordedProjectRoot(call), call);
});

test("MCP: the other drive-letter case answers exactly like the recorded spelling and writes nothing", onWindows, async (t) => {
  const { base, root } = fixture(t);
  const other = flip(root);
  assert.equal(recordedRootSpelling(other), root);
  for (const [name, args] of [
    ["lode_project_status", {}],
    ["lode_checkpoint_basis", {}],
    ["lode_conversation_enter", {}],
    ["lode_session_list", {}],
    ["lode_project_direction_read", {}],
  ]) {
    const expected = value(await dispatch(request(root, name, args)));
    const before = snapshot(base);
    const actual = value(await dispatch(request(other, name, args)));
    assert.deepEqual(snapshot(base), before, `${name} wrote because of the spelling`);
    assert.deepEqual(actual, expected, name);
  }
  // Routed through lode_tools_read as well.
  const routedCall = (spelling) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "lode_tools_read", arguments: { name: "lode_checkpoint_basis", arguments: { project_root: spelling } } },
  });
  assert.deepEqual(value(await dispatch(routedCall(other))), value(await dispatch(routedCall(root))));
  // A write with the other spelling lands on the same Project.
  const current = value(await dispatch(request(root, "lode_project_direction_read")))?.directionId ?? null;
  const update = value(
    await dispatch(
      request(other, "lode_project_direction_update", {
        expected_direction_id: current,
        direction: { goal: "g", constraints: [], decisions: [], cancelledActions: [] },
      }),
    ),
  );
  assert.equal(update.status, "updated");
  assert.equal(value(await dispatch(request(root, "lode_project_direction_read"))).directionId, update.direction.directionId);
});

test("MCP: a Project recorded with a lower-case drive letter answers the upper-case spelling too", onWindows, async (t) => {
  const { root } = fixture(t, { spell: (value) => value[0].toLowerCase() + value.slice(1) });
  assert.match(root, /^[a-z]:/);
  const upper = flip(root);
  assert.equal(value(await dispatch(request(upper, "lode_project_status"))).status, "core_ready");
  assert.deepEqual(value(await dispatch(request(upper, "lode_checkpoint_basis"))), value(await dispatch(request(root, "lode_checkpoint_basis"))));
});

test("a Project that really moved is still reported as relocated, in either drive-letter case", onWindows, async (t) => {
  const { base, root } = fixture(t);
  const moved = path.join(base, "moved");
  fs.renameSync(root, moved);
  for (const spelling of [moved, flip(moved)]) {
    const before = snapshot(base);
    assert.equal(value(await dispatch(request(spelling, "lode_project_status"))).status, "relocation_available");
    assert.deepEqual(snapshot(base), before);
  }
});

test("CLI: the other drive-letter case is the same Project", onWindows, async (t) => {
  const { base, root } = fixture(t);
  const other = flip(root);
  const before = snapshot(base);
  assert.equal((await runCommand(["status", other])).status, "core_ready");
  assert.deepEqual(await runCommand(["checkpoint-basis", other]), await runCommand(["checkpoint-basis", root]));
  assert.deepEqual(snapshot(base), before);
});

test("verified callers: both spellings share one held basis, Host binding and Session", onWindows, async (t) => {
  const { root, environment } = fixture(t);
  const other = flip(root);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const call = (spelling, name, args) => dispatch(request(spelling, name, args, { threadId: "thread-a" }), { nativeSessionBridge: bridge });
  value(await call(other, "lode_project_initialize_or_resume", {}));
  const entered = value(await call(other, "lode_conversation_enter", {}));
  assert.equal(entered.status, "conversation_ready");
  // Native observations recorded under the recorded spelling are shown for both.
  const event = { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "thread-a", turn_id: "turn-1" };
  await createNativeObservationStore({ environment }).observe({
    root,
    caller: { runtime: "codex", nativeSessionId: "thread-a", agentId: null },
    observation: normalizeNativeHook({ runtime: "codex", event }).observation,
  });
  const statusRecorded = (await call(root, "lode_project_status", {})).result;
  assert.match(JSON.stringify(statusRecorded), /turn-1/);
  assert.deepEqual((await call(other, "lode_project_status", {})).result, statusRecorded);
  assert.equal(bridge.recoveryBasisStatus().entries, 1);
  // Held through the other spelling, used through the recorded one: one entry.
  value(await call(other, "lode_checkpoint_basis", {}));
  assert.equal(bridge.recoveryBasisStatus().entries, 1);
  assert.equal(value(await call(root, "lode_checkpoint_sync", direction)).outcome, "created");
  assert.equal(value(await call(other, "lode_checkpoint_sync", { ...direction, current_position: "Again" })).outcome, "created");
  // The in-memory key itself treats the two spellings as one.
  const memory = createRecoveryBasisMemory().forCaller("caller");
  memory.hold(other, "session", "recovery-basis-000000000000000000000000");
  assert.equal(memory.held(root, "session"), "recovery-basis-000000000000000000000000");
});

test("Claude: a hook preparation made with the other spelling still matches its call", onWindows, async (t) => {
  const { root, environment } = fixture(t);
  const other = flip(root);
  const bridge = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => bridge.dispose());
  const call = async (name, args, id) => {
    const wire = request(other, name, args, { "claudecode/toolUseId": id });
    const hook = {
      jsonrpc: "2.0",
      id: "hook",
      method: "tools/call",
      params: {
        name: SESSION_HOST_REQUEST_HELPER,
        arguments: {
          native_session_id: "claude-session",
          native_agent_id: "",
          tool_use_id: id,
          outer_tool_name: "mcp__lode__" + name,
          original_arguments: JSON.stringify(wire.params.arguments),
        },
      },
    };
    assert.equal((await dispatch(hook, { nativeSessionBridge: bridge })).result.isError, undefined);
    return dispatch(wire, { nativeSessionBridge: bridge });
  };
  value(await call("lode_project_initialize_or_resume", {}, "init"));
  assert.equal(bridge.requestStatus().pending ?? 0, 0);
  value(await call("lode_checkpoint_basis", {}, "basis"));
  assert.equal(value(await call("lode_checkpoint_sync", direction, "sync")).outcome, "created");
});
