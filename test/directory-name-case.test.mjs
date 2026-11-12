import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { resolveProjectStorage } from "../scripts/lib/storage/project-storage-format.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { runSessionHostHook, sessionStartContext } from "../scripts/session-host-hook.mjs";
import { projectNativeObservations } from "../scripts/lib/session/native-session-observations.mjs";
import plugin from "../scripts/opencode-plugin.mjs";

// beta.118: a root whose directory names differ from the recorded Project root
// only in letter case reaches that Project on a case-insensitive filesystem.
// The on-disk spelling is looked up only after the Project was not found as
// given; nothing stored is rewritten and a moved Project is still relocated.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const probe = fs.mkdtempSync(path.join(os.tmpdir(), "lode-case-probe-"));
const caseInsensitive = fs.existsSync(probe.toUpperCase()) && fs.existsSync(probe.toLowerCase());
fs.rmSync(probe, { recursive: true, force: true });
const onCaseInsensitive = { skip: caseInsensitive ? false : "the filesystem is case-sensitive" };
const swapName = (root) => path.join(path.dirname(root), path.basename(root).toLowerCase());

function fixture(t, runtimes = ["claude", "codex"]) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lode-dir-case-")));
  const root = path.join(base, "MyProject");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"), LODE_SUBAGENT_WRITE_GUARD: "off" };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, other: swapName(root), environment };
}
const projectTree = (root) =>
  fs
    .readdirSync(path.join(root, ".lode"), { recursive: true })
    .filter((entry) => fs.statSync(path.join(root, ".lode", entry)).isFile())
    .sort()
    .map((entry) => [entry, fs.readFileSync(path.join(root, ".lode", entry), "utf8")]);
const call = async (root, name, args = {}) => {
  const response = await dispatch({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } });
  if (response.error) return { error: response.error.message, reasonCode: response.error.data?.reasonCode };
  return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
};
const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";

test("MCP: status, entry and initialize_or_resume reach the recorded Project from another directory-name case", onCaseInsensitive, async (t) => {
  const { root, other } = fixture(t);
  const before = projectTree(root);
  assert.equal((await call(other, "lode_project_status")).status, "core_ready");
  const entered = await call(other, "lode_conversation_enter");
  assert.notEqual(entered.reasonCode, "PROJECT_RELOCATION_AVAILABLE");
  assert.equal(entered.status, "conversation_ready");
  // Before beta.118 this call relocated the Project to the other spelling.
  assert.equal((await call(other, "lode_project_initialize_or_resume", { profile: "core" })).status, "core_ready");
  assert.deepEqual(projectTree(root), before, "nothing stored is rewritten");
});

test("a Project found as given costs no on-disk spelling lookup; only the miss does", onCaseInsensitive, async (t) => {
  const { root, other } = fixture(t);
  const original = fs.realpathSync.native;
  let lookups = 0;
  fs.realpathSync.native = (value, ...rest) => {
    if (String(value).toLowerCase() === root.toLowerCase()) lookups += 1;
    return original(value, ...rest);
  };
  try {
    await call(root, "lode_project_status");
    await call(root, "lode_conversation_enter");
    assert.equal(lookups, 0, "the found path reads nothing extra");
    await call(other, "lode_project_status");
    assert.ok(lookups >= 1, "the miss looks up the on-disk spelling");
  } finally {
    fs.realpathSync.native = original;
  }
});

test("outside an entry point Project selection keeps its previous result", onCaseInsensitive, (t) => {
  const { other } = fixture(t);
  assert.equal(resolveProjectStorage(other), null);
});

test("CLI: the root argument in another directory-name case reaches the recorded Project", onCaseInsensitive, async (t) => {
  const { root, other } = fixture(t);
  const before = projectTree(root);
  const result = await runCommand(["status", other]);
  assert.equal(result.status, "core_ready", JSON.stringify(result).slice(0, 300));
  assert.deepEqual(projectTree(root), before);
});

test("Host hooks: SessionStart and observations from another directory-name case use the recorded Project", onCaseInsensitive, async (t) => {
  const { root, other, environment } = fixture(t);
  const before = projectTree(root);
  const event = (cwd, session) => ({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: session });
  const fromOther = context(await sessionStartContext({ runtime: "claude", event: event(other, "native-other"), environment }));
  const fromRecorded = context(await sessionStartContext({ runtime: "claude", event: event(root, "native-recorded"), environment }));
  assert.doesNotMatch(fromOther, /PROJECT_RELOCATION_AVAILABLE|host_context_unavailable/);
  assert.equal(fromOther.replaceAll("native-other", "X"), fromRecorded.replaceAll("native-recorded", "X"));
  const caller = { runtime: "codex", nativeSessionId: "thread-other", agentId: null };
  await runSessionHostHook({
    runtime: "codex",
    observeOnly: true,
    environment,
    event: { hook_event_name: "UserPromptSubmit", cwd: other, session_id: caller.nativeSessionId, turn_id: "turn-other", prompt: "Keep this" },
  });
  assert.match(JSON.stringify(await projectNativeObservations({ root, caller, environment })), /turn-other/);
  assert.deepEqual(projectTree(root), before);
});

test("OpenCode: a directory in another letter case delivers the recorded Project's context", onCaseInsensitive, async (t) => {
  const { root, other, environment } = fixture(t, ["opencode"]);
  const sessionID = "ses_other_case";
  const client = {
    session: {
      get: async () => ({ data: { id: sessionID, projectID: "host-project", directory: other } }),
      status: async () => ({ data: {} }),
    },
  };
  const hooks = await plugin.server({ client, project: { id: "host-project" }, directory: other }, { environment });
  t.after(() => hooks.dispose());
  const before = projectTree(root);
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, output);
  const delivered = output.system.join("\n");
  assert.ok(delivered.length > 0);
  assert.doesNotMatch(delivered, /optional request context unavailable|PROJECT_RELOCATION_AVAILABLE/);
  assert.deepEqual(projectTree(root), before);
});

test("a folder renamed to another letter case keeps today's results in both spellings", onCaseInsensitive, async (t) => {
  const { root, other } = fixture(t);
  fs.renameSync(root, other);
  assert.equal(fs.realpathSync.native(other), other, "the on-disk spelling is the new one");
  // The recorded spelling is still found as given (as before), and the new
  // on-disk spelling is not the recorded one, so it stays a relocation.
  assert.equal((await call(root, "lode_project_status")).status, "core_ready");
  assert.equal((await call(other, "lode_project_status")).status, "relocation_available");
});

test("a moved Project is still reported as relocated", onCaseInsensitive, async (t) => {
  const { base, root } = fixture(t);
  const moved = path.join(base, "Moved");
  fs.renameSync(root, moved);
  for (const spelling of [moved, swapName(moved)]) assert.equal((await call(spelling, "lode_project_status")).status, "relocation_available", spelling);
});

test(
  "Windows: a lower-case drive letter together with another directory-name case",
  { skip: process.platform === "win32" ? false : "drive letters exist only on Windows" },
  async (t) => {
    const { root, other } = fixture(t);
    const both = other[0].toLowerCase() + other.slice(1);
    assert.equal((await call(both, "lode_project_status")).status, "core_ready");
  },
);

test("a command Hook from another directory-name case delivers its output once, for the recorded Project", onCaseInsensitive, async (t) => {
  const { other, environment } = fixture(t);
  const delivered = [];
  await runSessionHostHook({
    runtime: "claude",
    environment,
    event: { hook_event_name: "SessionStart", source: "startup", cwd: other, session_id: "native-deliver" },
    deliver: (output) => delivered.push(context(output)),
  });
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0], /PROJECT_RELOCATION_AVAILABLE|host_context_unavailable|PROJECT_ROOT_SPELLING_RETRY/);
});
