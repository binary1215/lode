import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dispatch } from "../scripts/mcp-server.mjs";
import { initializeProject } from "../scripts/lib/session/lode-core.mjs";
import { resolveProjectStorage } from "../scripts/lib/storage/project-storage-format.mjs";
import { inspectConversationalOnboarding } from "../scripts/lib/session/onboarding-conversation.mjs";
import { validateProjectRootArgument } from "../scripts/lib/core/mcp-argument-validation.mjs";

// These tests pin the documented MCP contract to actual behavior: declared
// inputSchemas are enforced, library reason codes reach the wire, and a Lode
// Project recorded for another root is reported as an existing Project rather
// than an uninitialized folder, by tools and by the SessionStart Hook alike.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const hook = path.join(pluginRoot, "scripts/session-host-hook.mjs");
const call = (name, args = {}, options) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, options);
function tempRoot(t, prefix) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t, runtimes = ["codex"]) {
  const root = tempRoot(t, "lode-contract-");
  initializeProject({ root, pluginRoot, runtimes });
  return root;
}

test("project_root is enforced as declared; every other argument rule stays the operation's own refusal", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["project_root", "confirm"],
    properties: { project_root: { type: "string", minLength: 1 }, depth: { type: "integer", maximum: 8 }, confirm: { type: "boolean", const: true } },
  };
  assert.deepEqual(validateProjectRootArgument(schema, { project_root: "x" }), []);
  assert.deepEqual(
    validateProjectRootArgument(schema, { project_root: "x", depth: 9, confirm: false, extra: true }),
    [],
    "bounds, confirmation flags and unknown fields keep the operation's own, CLI-identical refusal",
  );
  assert.deepEqual(validateProjectRootArgument(schema, {}), ["arguments.project_root is required"]);
  assert.deepEqual(validateProjectRootArgument(schema, { project_root: undefined }), ["arguments.project_root is required"]);
  assert.deepEqual(validateProjectRootArgument(schema, { project_root: 5 }), ["arguments.project_root must be string, got number"]);
  assert.deepEqual(validateProjectRootArgument(schema, { project_root: null }), ["arguments.project_root must be string, got null"]);
  assert.deepEqual(validateProjectRootArgument(schema, { project_root: "" }), ["arguments.project_root must have at least 1 characters"]);
  assert.deepEqual(validateProjectRootArgument({ type: "object", properties: {} }, {}), [], "tools without a project root are untouched");
  assert.deepEqual(validateProjectRootArgument({ type: "object", properties: { project_root: { type: "string" } } }, {}), [], "an optional root may be absent");
});

test("a missing, empty or non-string project_root is refused before any argument is read, directly and through the router", async (t) => {
  const root = fixture(t);
  const refused = async (name, args) => {
    const response = await call(name, args);
    assert.equal(response.error?.data?.reasonCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(response));
    return response.error.message;
  };
  assert.match(await refused("lode_project_status", {}), /project_root is required/, "a missing root is not the server's current directory");
  assert.match(
    await refused("lode_project_status", { project_root: 12345 }),
    /project_root must be string/,
    "a wrong type is a contract refusal, not a Node TypeError",
  );
  assert.match(await refused("lode_project_status", { project_root: "" }), /at least 1 characters/);
  assert.match(await refused("lode_tools_read", { name: "lode_session_work_read", arguments: {} }), /lode_session_work_read.*project_root is required/);
  const bound = await call("lode_project_graph", { project_root: root, query: "x", depth: 9 });
  assert.equal(bound.error.data.reasonCode, "INVALID_PROJECT_GRAPH_BOUND", "other argument rules remain the operation's own refusal, now with its code");
  const notRead = await call("lode_tools_read", { name: "lode_checkpoint_sync", arguments: {} });
  assert.match(notRead.error.message, /not read-only/, "router checks keep precedence over argument structure");
  const ok = await call("lode_project_status", { project_root: root });
  assert.equal(ok.error, undefined);
  assert.equal(ok.result.structuredContent.status, "core_ready");
});

test("library reason codes reach the MCP error as data.reasonCode", async (t) => {
  const empty = tempRoot(t, "lode-empty-"),
    root = fixture(t);
  const response = await call("lode_pending_review", { project_root: empty });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.reasonCode, "PROJECT_NOT_READY");
  assert.equal((await call("lode_pending_review", { project_root: root })).error.data.reasonCode, "NO_PENDING_REVIEW");
  const work = await call("lode_tools_read", { name: "lode_session_work_read", arguments: { project_root: empty } });
  assert.equal(work.error.data.reasonCode, "NOT_INITIALIZED", "an uninitialized folder is not a raw ENOENT on a legacy path");
  const unknown = await dispatch({ jsonrpc: "2.0", id: 2, method: "nothing/here" });
  assert.deepEqual(unknown.error, { code: -32000, message: "Method not found" }, "errors without a reason code carry no data");
});

test("a copied Lode Project stays unadopted by implicit readers but is named as an existing Project by entry, status and the SessionStart Hook", async (t) => {
  const original = fixture(t),
    copy = tempRoot(t, "lode-moved-");
  fs.cpSync(original, copy, { recursive: true });
  const before = fs.readdirSync(copy).sort();
  assert.equal(resolveProjectStorage(copy), null, "implicit readers still see no owned storage here");
  const entered = await call("lode_conversation_enter", { project_root: copy });
  assert.equal(entered.error, undefined);
  assert.equal(entered.result.structuredContent.status, "conversation_recovery_unavailable");
  assert.equal(entered.result.structuredContent.reasonCode, "PROJECT_RELOCATION_AVAILABLE");
  assert.equal(entered.result.structuredContent.nextAction.id, "resume_existing_project");
  assert.equal(entered.result.structuredContent.projectLocation.adopted, false);
  const status = await call("lode_project_status", { project_root: copy });
  assert.equal(status.error, undefined);
  assert.equal(status.result.structuredContent.status, "relocation_available");
  assert.equal(status.result.structuredContent.nextAction.id, "resume_existing_project");
  assert.deepEqual(fs.readdirSync(copy).sort(), before, "reads adopt nothing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, ".lode/project.json"), "utf8")).projectRoot, original, "the recorded root is untouched by reads");
  const event = { session_id: "synthetic-session", cwd: copy, hook_event_name: "SessionStart", source: "startup" };
  const run = spawnSync(process.execPath, [hook, "--runtime", "claude"], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  const context = JSON.parse(JSON.parse(run.stdout).hookSpecificOutput.additionalContext);
  assert.equal(context.status, "host_context_unavailable");
  assert.equal(context.reasonCode, "PROJECT_RELOCATION_AVAILABLE");
  assert.equal(context.nextAction.id, "resume_existing_project");
  const empty = tempRoot(t, "lode-plain-empty-");
  const plain = spawnSync(process.execPath, [hook, "--runtime", "claude"], {
    input: JSON.stringify({ ...event, cwd: empty }),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout), {}, "a truly empty folder keeps the existing silent SessionStart contract");
  assert.equal(context.ordinaryWorkBlocked, false);
});

test("withheld root instruction notice names each file once and never prints undefined", async (t) => {
  const root = tempRoot(t, "lode-withheld-");
  const response = await call("lode_project_initialize_or_resume", { project_root: root, profile: "core", runtimes: ["claude", "codex"] });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  const text = response.result.content[0].text;
  assert.match(text, /were not created or modified \(claude CLAUDE\.md, codex AGENTS\.md\)/);
  assert.doesNotMatch(text, /undefined/);
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
});

test("onboarding guide on an initialized Core project asks for product evidence instead of repeating initialize_or_resume", async (t) => {
  const root = fixture(t);
  const guide = await inspectConversationalOnboarding({ root });
  assert.equal(guide.status, "initialized");
  assert.equal(guide.nextAction, "provide_product_evidence");
  const fresh = await inspectConversationalOnboarding({ root: tempRoot(t, "lode-fresh-") });
  assert.equal(fresh.nextAction, "initialize_or_resume");
});
