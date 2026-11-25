// First-use path (beta.137): the right next step for a moved, copied or empty
// folder, refusals that say what is wrong and what to do, and the decisions
// D1 (CLI resume creates nothing), D2 (unknown options and arguments are
// refused) and D3 (.mcp.json is named). All fixtures are made up.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { initializeOrResumeProject } from "../scripts/lib/session/project-bootstrap.mjs";
import { enterConversationRecovery } from "../scripts/lib/session/compaction-lifecycle.mjs";
import { formatCliResult } from "../scripts/lib/session/cli-presentation.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { REFUSAL_TEXT, failExplained, runtimeMismatchText } from "../scripts/lib/core/refusal-text.mjs";
import { inspectProjectCopyInput } from "../scripts/lib/storage/project-copy-adoption.mjs";
import { decodeProductGraphText, verifyProductGraphCanonFile, PRODUCT_GRAPH_RULES_FILE } from "../scripts/lib/storage/product-graph-store.mjs";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";

const MANAGED = ".lode/generated/lode-instructions.md";

function folder(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(pluginRoot, ".qa-first-use-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
async function project(t, name = "P", runtimes = ["claude"]) {
  const base = folder(t);
  const root = path.join(base, name);
  fs.mkdirSync(root);
  const result = await initializeOrResumeProject({ root, pluginRoot, runtimes });
  return { base, root, result };
}
function moved(f, name = "Q") {
  const target = path.join(f.base, name);
  fs.renameSync(f.root, target);
  return target;
}
function copied(f, name = "R") {
  const target = path.join(f.base, name);
  fs.cpSync(f.root, target, { recursive: true });
  return target;
}
async function refusal(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}
const mcp = (name, args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const writeJson = (base, name, value) => {
  const file = path.join(base, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

test("a moved Project: conversation entry names resume at every depth, never Core initialization", async (t) => {
  const f = await project(t);
  const root = moved(f);
  const entry = await enterConversationRecovery({ root });
  assert.equal(entry.reasonCode, "PROJECT_RELOCATION_AVAILABLE");
  assert.equal(entry.nextAction.id, "resume_existing_project");
  // A consumer reading only projectStatus reaches the same conclusion.
  assert.equal(entry.projectStatus.status, "relocation_available");
  assert.equal(entry.projectStatus.nextAction.id, "resume_existing_project");
  assert.deepEqual(
    entry.projectStatus.attention.items.map((item) => item.id),
    ["project-location-resume"],
  );
  const whole = JSON.stringify(entry);
  assert.ok(!whole.includes("initialize_core"), "no initialize_core at any depth");
  assert.ok(!whole.includes("core-initialization"), "no core-initialization at any depth");
  const text = formatCliResult("conversation-enter", entry);
  assert.match(text, /Resume this existing Project explicitly; do not initialize a replacement/);
  assert.doesNotMatch(text, /Initialize the Core/);
});

test("reads before resume on a moved Project name the Project and resume, not a .head path", async (t) => {
  const f = await project(t);
  const root = moved(f);
  for (const argv of [["session-list", root], ["project-direction-read", root], ["session-create", root, "--purpose", "synthetic"]]) {
    const error = await refusal(() => runCommand(argv));
    assert.equal(error.code, "PROJECT_RELOCATION_AVAILABLE", argv[0]);
    assert.match(error.message, /has not been resumed at this folder/);
    assert.match(error.message, /resume <project>/);
    assert.match(error.message, /do not initialize a replacement/);
    assert.ok(error.message.includes(f.result.project.projectId), "names the retained Project");
    assert.doesNotMatch(error.message, /ENOENT|\.head/);
  }
  const response = await mcp("lode_project_direction_read", { project_root: root });
  assert.equal(response.error.data.reasonCode, "PROJECT_RELOCATION_AVAILABLE");
});

test("a folder that was never initialized, or does not exist, gets a sentence instead of ENOENT", async (t) => {
  const base = folder(t);
  const empty = path.join(base, "EMPTY");
  fs.mkdirSync(empty);
  for (const argv of [["session-list", empty], ["project-direction-read", empty], ["session-create", empty, "--purpose", "x"]]) {
    const error = await refusal(() => runCommand(argv));
    assert.equal(error.code, "NOT_INITIALIZED", argv[0]);
    assert.ok(error.message.includes(empty));
    assert.match(error.message, /CLI init <project>/);
    assert.doesNotMatch(error.message, /ENOENT|\.head/);
  }
  const missing = path.join(base, "MISSING");
  for (const argv of [["status", missing], ["session-list", missing], ["init", missing]]) {
    const error = await refusal(() => runCommand(argv));
    assert.equal(error.code, "PROJECT_NOT_FOUND", argv[0]);
    assert.match(error.message, /does not exist/);
    assert.ok(error.message.includes(missing));
  }
  assert.deepEqual(fs.readdirSync(empty), [], "nothing was created");
});

for (const [label, prepare] of [
  ["copied with the original present", (f) => copied(f)],
  ["moved", (f) => moved(f)],
]) {
  test(`${label} with a managed file missing: status, resume and entry answer PROJECT_NOT_READY naming the file`, async (t) => {
    const f = await project(t);
    const root = prepare(f);
    fs.rmSync(path.join(root, MANAGED));
    for (const command of ["status", "resume"]) {
      const error = await refusal(() => runCommand([command, root]));
      assert.equal(error.code, "PROJECT_NOT_READY", command);
      assert.ok(error.message.includes(MANAGED), `${command} names the file`);
      assert.match(error.message, /no step that repairs/);
      assert.doesNotMatch(error.message, /ENOENT/);
    }
    const entry = await enterConversationRecovery({ root });
    assert.equal(entry.reasonCode, "PROJECT_NOT_READY");
    assert.equal(entry.projectStatus.status, "relocation_blocked");
    assert.ok(!JSON.stringify(entry).includes("initialize_core"));
    assert.ok(formatCliResult("conversation-enter", entry).includes(MANAGED));
  });
}

test("not moved, a managed file missing: resume names the file and says no step repairs it", async (t) => {
  const f = await project(t);
  fs.rmSync(path.join(f.root, MANAGED));
  const error = await refusal(() => runCommand(["resume", f.root]));
  assert.equal(error.code, "PROJECT_NOT_READY");
  assert.ok(error.message.includes(`${MANAGED} (missing)`));
  assert.match(error.message, /has no step that repairs a missing or changed one/);
  assert.match(error.message, /resume again/);
});

test("PROJECT_RUNTIME_MISMATCH has one wording: recorded set, requested set and what the caller can do", async (t) => {
  const f = await project(t);
  const error = await refusal(() => runCommand(["init", f.root, "--runtime", "codex"]));
  assert.equal(error.code, "PROJECT_RUNTIME_MISMATCH");
  for (const fact of ["runtimes claude", "named codex", "--runtime claude", "no step that changes the runtime set"]) assert.ok(error.message.includes(fact), fact);
  // The copied-Project check gives the same sentence.
  const copy = copied(f);
  const copyError = await refusal(() => inspectProjectCopyInput({ root: copy, pluginRoot, runtimes: ["codex"] }));
  assert.equal(copyError.code, "PROJECT_RUNTIME_MISMATCH");
  assert.equal(copyError.message, runtimeMismatchText(["claude"], ["codex"]));
  const unsupported = await refusal(() => inspectProjectCopyInput({ root: copy, pluginRoot, runtimes: "codex" }));
  assert.equal(unsupported.code, "UNSUPPORTED_RUNTIME");
  assert.match(unsupported.message, /list of runtime names \(claude, codex, opencode\)/);
});

test("D1: CLI resume on a folder with no Project refuses and creates nothing; init and the MCP tool create", async (t) => {
  const base = folder(t);
  const empty = path.join(base, "EMPTY");
  fs.mkdirSync(empty);
  const error = await refusal(() => runCommand(["resume", empty]));
  assert.equal(error.code, "NOT_INITIALIZED");
  assert.match(error.message, /No Lode Project is here to resume/);
  assert.match(error.message, /Use init/);
  assert.deepEqual(fs.readdirSync(empty), []);
  // A .lode or .head folder without a Project record is still no Project.
  for (const directory of [".lode", ".head"]) {
    const holder = path.join(base, `EMPTY${directory}`);
    fs.mkdirSync(path.join(holder, directory), { recursive: true });
    const refused = await refusal(() => runCommand(["resume", holder]));
    assert.equal(refused.code, "NOT_INITIALIZED", directory);
    assert.match(refused.message, /holds no Lode Project/);
    assert.deepEqual(fs.readdirSync(holder), [directory], "nothing was created");
    assert.deepEqual(fs.readdirSync(path.join(holder, directory)), []);
  }
  await runCommand(["init", empty, "--runtime", "claude"]);
  assert.ok(fs.existsSync(path.join(empty, ".lode", "project.json")));
  const other = path.join(base, "OTHER");
  fs.mkdirSync(other);
  const response = await mcp("lode_project_initialize_or_resume", { project_root: other, runtimes: ["claude"] });
  assert.ok(!response.error, JSON.stringify(response.error));
  assert.ok(fs.existsSync(path.join(other, ".lode", "project.json")));
});

test("D2: an unknown CLI option or MCP argument is refused with its name and the near spelling", async (t) => {
  const f = await project(t);
  const bogus = await refusal(() => runCommand(["status", f.root, "--bogus", "x"]));
  assert.equal(bogus.code, "CLI_UNKNOWN_OPTION");
  assert.match(bogus.message, /status does not accept --bogus/);
  const near = await refusal(() => runCommand(["conversation-enter", f.root, "--sesion", "abc"]));
  assert.equal(near.code, "CLI_UNKNOWN_OPTION");
  assert.match(near.message, /--sesion \(did you mean --session\?\)/);
  const unknown = await mcp("lode_project_status", { project_root: f.root, bogus: 1 });
  assert.equal(unknown.error.data.reasonCode, "INVALID_TOOL_ARGUMENTS");
  assert.match(unknown.error.message, /"bogus" is not an argument of lode_project_status/);
  const spelled = await mcp("lode_conversation_enter", { project_root: f.root, sesion_id: "x" });
  assert.match(spelled.error.message, /did you mean "session_id"\?/);
  const inside = await mcp("lode_session", { action: "work_record", project_root: f.root, summary: "x" });
  assert.match(inside.error.message, /"summary" is not an argument of lode_session \(action work_record\); it belongs inside "evidence"/);
  const wrapper = await mcp("lode_session", { action: "work_record", project_root: f.root, work_evidence: { summary: "x" } });
  assert.match(wrapper.error.message, /"work_evidence" .*did you mean "evidence"\?/);
  // A tool that declares no arguments says so instead of an empty list.
  const none = await mcp("lode_core_contract", { project_root: f.root });
  assert.equal(none.error.data.reasonCode, "INVALID_TOOL_ARGUMENTS");
  assert.match(none.error.message, /"project_root" is not an argument of lode_core_contract; lode_core_contract takes no arguments\./);
  assert.doesNotMatch(none.error.message, /declared arguments: \./);
});

test("D2 on the routing tools: discover, read and call name the argument; nested routing keeps its refusal", async (t) => {
  const f = await project(t);
  const discover = await mcp("lode_tools_discover", { project_root: f.root, query: "direction", bogus: 2 });
  assert.equal(discover.error.data.reasonCode, "INVALID_TOOL_ARGUMENTS");
  assert.match(discover.error.message, /"project_root" is not an argument of lode_tools_discover/);
  assert.match(discover.error.message, /"query" is not an argument of lode_tools_discover/);
  assert.match(discover.error.message, /"bogus" is not an argument of lode_tools_discover/);
  assert.match(discover.error.message, /declared arguments: name, prefix, offset, limit/);
  const spelled = await mcp("lode_tools_discover", { prefx: "lode_product" });
  assert.match(spelled.error.message, /"prefx" .*did you mean "prefix"\?/);
  const read = await mcp("lode_tools_read", { name: "lode_project_status", arguments: { project_root: f.root }, project_root: f.root });
  assert.equal(read.error.data.reasonCode, "INVALID_TOOL_ARGUMENTS");
  assert.match(read.error.message, /"project_root" is not an argument of lode_tools_read; declared arguments: name, arguments\./);
  const call = await mcp("lode_tools_call", { name: "lode_project_status", arguments: { project_root: f.root }, execution_mod: "ordinary" });
  assert.match(call.error.message, /"execution_mod" .*did you mean "execution_mode"\?/);
  const nested = await mcp("lode_tools_read", { name: "lode_tools_read", arguments: { name: "lode_project_status", arguments: {} } });
  assert.match(nested.error.message, /routing cannot be nested/);
  const ok = await mcp("lode_tools_read", { name: "lode_project_status", arguments: { project_root: f.root } });
  assert.ok(!ok.error, JSON.stringify(ok.error));
});

test("every --option a usage line names is accepted by its command, so the help and the D2 check agree", async () => {
  const { usage, acceptedCliOptions } = await import("../scripts/lode.mjs");
  const lines = new Set();
  for (const surface of ["ordinary", "managed-maintenance"]) {
    const help = usage({ all: true, surface });
    for (const line of help.commands) lines.add(line);
    for (const [command, note] of Object.entries(help.commandNotes ?? {})) lines.add(`notes ${command} ${note}`);
  }
  let checked = 0;
  const offered = [];
  for (const line of lines) {
    const match = line.match(/^\S+\s+(?:managed-maintenance\s+)?([a-z][a-z0-9-]*)\b(.*)$/);
    if (!match) continue;
    const accepted = acceptedCliOptions(match[1]);
    const options = [...match[2].matchAll(/--([a-z][a-z0-9-]*)/g)].map((item) => item[1]).filter((option) => option !== "json");
    if (!accepted) continue;
    checked += 1;
    for (const option of options) if (!accepted.has(option)) offered.push(`${match[1]} --${option}`);
  }
  assert.ok(checked > 150, `usage lines checked: ${checked}`);
  assert.deepEqual(offered, []);
});

test("D3: init names the project-root .mcp.json it writes for the claude runtime", async (t) => {
  const f = await project(t);
  assert.ok(fs.existsSync(path.join(f.root, ".mcp.json")));
  const text = formatCliResult("init", f.result);
  assert.match(text, /Claude Code MCP: Lode wrote or keeps \.mcp\.json at the project root/);
  assert.match(text, /absolute paths to this plugin/);
  const codex = await project(t, "C", ["codex"]);
  assert.doesNotMatch(formatCliResult("init", codex.result), /\.mcp\.json/);
});

test("4.4: four first-use commands print text without --json and keep the object for --json", async (t) => {
  const f = await project(t);
  const none = await runCommand(["project-direction-read", f.root]);
  assert.equal(none, null);
  assert.match(formatCliResult("project-direction-read", none), /No common Project direction is recorded/);
  const input = writeJson(f.base, "direction.json", { goal: "Ship the synthetic fix", constraints: ["No schema change"], decisions: [], cancelledActions: [] });
  const updated = await runCommand(["project-direction-update", f.root, "--input", input]);
  assert.equal(updated.status, "updated");
  assert.equal(updated.direction.kind, "ProjectDirection");
  const id = updated.direction.directionId;
  const updateText = formatCliResult("project-direction-update", updated);
  assert.match(updateText, new RegExp(`Common Project direction recorded: ${id}`));
  assert.match(updateText, /Constraint: No schema change/);
  assert.ok(!updateText.trimStart().startsWith("{"));
  const read = await runCommand(["project-direction-read", f.root]);
  assert.equal(read.directionId, id);
  assert.match(formatCliResult("project-direction-read", read), new RegExp(`--expected-direction ${id}`));
  const created = await runCommand(["session-create", f.root, "--purpose", "synthetic review"]);
  assert.equal(created.status, "created");
  assert.match(formatCliResult("session-create", created), new RegExp(`Session created: ${created.sessionId} "synthetic review"`));
  const checkpoint = await runCommand(["checkpoint", f.root, "--summary", "synthetic position", "--next", "synthetic next"]);
  assert.equal(checkpoint.status, "checkpointed");
  assert.equal(checkpoint.checkpoint.kind, "SessionRunCheckpoint");
  const checkpointText = formatCliResult("checkpoint", checkpoint);
  assert.match(checkpointText, /Recovery checkpoint recorded: checkpoint-[a-f0-9]+/);
  assert.match(checkpointText, /Purpose: synthetic position/);
  const listed = await runCommand(["session-list", f.root]);
  const lines = formatCliResult("session-list", listed)
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.includes(created.sessionId) && line.includes('"synthetic review"')));
  assert.ok(lines.some((line) => line.includes("(default; selected when no Session is named)")));
  const noSummary = await refusal(() => runCommand(["checkpoint", f.root]));
  // Already refused with text on main; unchanged.
  assert.match(noSummary.message, /Checkpoint purpose is required/);
});

test("saving direction: a refused key is named with the accepted keys; a missing id is told apart from a conflict", async (t) => {
  const f = await project(t);
  const refused = writeJson(f.base, "refused.json", { goal: "g", constraints: [], decisions: [], cancellations: [] });
  const keyError = await refusal(() => runCommand(["project-direction-update", f.root, "--input", refused]));
  assert.equal(keyError.code, "INVALID_PROJECT_DIRECTION_INPUT");
  assert.match(keyError.message, /does not accept "cancellations"; the accepted keys are goal, constraints, decisions, cancelledActions/);
  const first = writeJson(f.base, "first.json", { goal: "g", constraints: [], decisions: [], cancelledActions: [] });
  const recorded = await runCommand(["project-direction-update", f.root, "--input", first]);
  const id = recorded.direction.directionId;
  const second = writeJson(f.base, "second.json", { goal: "g2", constraints: [], decisions: [], cancelledActions: [] });
  const missing = await refusal(() => runCommand(["project-direction-update", f.root, "--input", second]));
  assert.equal(missing.code, "PROJECT_DIRECTION_CONFLICT");
  assert.ok(missing.message.includes(id));
  assert.match(missing.message, /must name the revision it was derived from/);
  assert.match(missing.message, /project-direction-read/);
  const wrong = await refusal(() =>
    runCommand(["project-direction-update", f.root, "--input", second, "--expected-direction", "direction-000000000000000000000000"]),
  );
  assert.equal(wrong.code, "PROJECT_DIRECTION_CONFLICT");
  assert.match(wrong.message, /derive against its current exact basis/);
  assert.ok(wrong.message.includes(`The current revision is ${id}`));
});

test("checkpoint sync and work record refusals say what the caller must supply", async (t) => {
  const f = await project(t);
  const sync = writeJson(f.base, "sync.json", { purpose: "p", approvedDecisions: [], currentPosition: "c", nextExpectedResult: "n" });
  const syncError = await refusal(() => runCommand(["checkpoint-sync", f.root, "--input", sync]));
  assert.equal(syncError.code, "INVALID_COMPACTION_INPUT");
  for (const fact of ["lode_checkpoint_basis", "expected_recovery_basis_id", "last created sync", "Host-verified caller"]) assert.ok(syncError.message.includes(fact), fact);
  const noEvidence = await mcp("lode_session", { action: "work_record", project_root: f.root });
  assert.match(noEvidence.error.message, /needs the argument evidence/);
  assert.match(noEvidence.error.message, /work_evidence/);
  const todo = (item) => mcp("lode_session", { action: "work_record", project_root: f.root, evidence: { todos: [item] } });
  const origin = await todo({ todoId: "todo-a", task: "x", status: "pending", nextAction: "y" });
  assert.match(origin.error.message, /Todo todo-a needs origin: user-directed/);
  const status = await todo({ todoId: "todo-a", task: "x", status: "open", origin: "user-directed", nextAction: "y" });
  assert.match(status.error.message, /needs status: one of pending, partial, waiting, completed, cancelled; got "open"/);
  const id = await todo({ todoId: "t1", task: "x", status: "pending", origin: "user-directed", nextAction: "y" });
  assert.match(id.error.message, /"t1" is not a stable Todo ID: use "todo-"/);
});

test("codes that got text: the shared table, and refusals reached here carry the refused value", async (t) => {
  for (const [code, text] of Object.entries(REFUSAL_TEXT)) {
    assert.ok(typeof text === "string" && text.length > 40 && text !== code, code);
    assert.throws(
      () => failExplained(code),
      (error) => error.code === code && error.message === text,
    );
  }
  assert.throws(() => decodeProductGraphText(Buffer.from([0xff, 0xfe])), (error) => error.code === "PRODUCT_GRAPH_FILE_NOT_UTF8" && /UTF-8/.test(error.message));
  assert.throws(
    () => verifyProductGraphCanonFile("synthetic/unknown.bin", Buffer.from("x")),
    (error) => error.code === "PRODUCT_GRAPH_PATH_UNSUPPORTED" && error.message.includes("synthetic/unknown.bin"),
  );
  assert.throws(
    () => verifyProductGraphCanonFile(PRODUCT_GRAPH_RULES_FILE, Buffer.from("{not json")),
    (error) => error.code === "PRODUCT_GRAPH_RULES_INVALID" && error.message.includes(PRODUCT_GRAPH_RULES_FILE),
  );
  const f = await project(t);
  const documents = path.join(f.base, "no-documents");
  assert.throws(
    () =>
      buildProductGraph({
        sourceRoot: f.root,
        documentsDirectory: documents,
        rulesFile: path.join(f.base, "rules.json"),
        outputDirectory: path.join(f.base, "out"),
      }),
    (error) => error.code === "PRODUCT_GRAPH_DOCUMENTS_MISSING" && error.message.includes(documents),
  );
  const view = await refusal(() => runCommand(["graph-explorer", f.root, "--view", "nope"]));
  assert.equal(view.code, "GRAPH_EXPLORER_INVALID_VIEW");
  assert.match(view.message, /Unknown view "nope". Use one of: status, product, gaps, map/);
  const existing = path.join(f.base, "explorer.html");
  fs.writeFileSync(existing, "synthetic");
  const output = await refusal(() => runCommand(["graph-explorer", f.root, "--output", existing]));
  assert.equal(output.code, "GRAPH_EXPLORER_OUTPUT_EXISTS");
  assert.ok(output.message.includes(existing));
  const cursor = await refusal(() => runCommand(["graph-query", f.root, "--inventory-page", "--inventory-cursor", "not a cursor!"]));
  assert.equal(cursor.code, "INVALID_PROJECT_GRAPH_INVENTORY_CURSOR");
  assert.match(cursor.message, /Pass the next cursor of the previous page/);
  const bound = await refusal(() => runCommand(["graph-query", f.root, "--query", "x", "--max-nodes", "0"]));
  assert.equal(bound.code, "INVALID_PROJECT_GRAPH_BOUND");
  assert.match(bound.message, /out of range: 0 \(allowed: whole numbers from 1 to \d+\)/);
  const empty = path.join(f.base, "EMPTY");
  fs.mkdirSync(empty);
  const inventory = await refusal(() => runCommand(["graph-query", empty, "--inventory-page"]));
  assert.equal(inventory.code, "PROJECT_GRAPH_NOT_INITIALIZED");
  assert.ok(inventory.message.includes(empty));
  const destination = path.join(f.base, "bundle");
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "other.txt"), "synthetic");
  const notEmpty = await refusal(() => runCommand(["project-export", f.root, "--destination", destination]));
  assert.equal(notEmpty.code, "PROJECT_BUNDLE_DESTINATION_NOT_EMPTY");
  assert.ok(notEmpty.message.includes(destination));
  const exportEmpty = await refusal(() => runCommand(["project-export", empty, "--destination", path.join(f.base, "bundle2")]));
  assert.equal(exportEmpty.code, "NOT_INITIALIZED");
  assert.match(exportEmpty.message, /before exporting a bundle/);
});

// Sites whose refusal needs a race or thousands of files: the listed call must
// carry text with its facts (checked in the source, not by triggering). Other
// sites raising the same code are outside this bundle and stay as they are.
test("codes that got text: hard-to-trigger sites pass a message, not the bare code", () => {
  const source = (relative) => fs.readFileSync(path.join(pluginRoot, relative), "utf8");
  for (const [file, code, facts] of [
    ["scripts/lib/world/project-graph.mjs", "PROJECT_GRAPH_READ_DRIFT", ["entry.path", "Read the graph again"]],
    ["scripts/lib/world/project-graph.mjs", "PROJECT_GRAPH_DEPENDENCY_UNAVAILABLE", ["${layer}", "other layers and ordinary work are not affected"]],
    ["scripts/lib/world/discovery-index.mjs", "PROJECT_IDENTITY_MISMATCH", ["${projectRoot}", "Resume the Project at this folder"]],
    ["scripts/lib/world/product-graph.mjs", "PRODUCT_GRAPH_TOO_MANY_FILES", ["${PRODUCT_GRAPH_MAX_FILES}", "${relative}"]],
    ["scripts/lib/session/conversation-messaging.mjs", "CONVERSATION_TARGET_CHANGED", ["re-registered or changed its channel", "List the conversations again"]],
    ["scripts/lib/storage/project-copy-adoption.mjs", "PROJECT_RELOCATION_PENDING", ["${initial.currentRoot}", "already pending"]],
    ["scripts/lib/storage/project-copy-adoption.mjs", "PROJECT_NOT_READY", ["${entry.path}", "no step that repairs"]],
  ]) {
    const text = source(file);
    const at = text.indexOf(`"${code}",`);
    assert.ok(at >= 0, `${code} passes a message in ${file}`);
    const call = text.slice(at, at + 600);
    for (const fact of facts) assert.ok(call.includes(fact), `${code}: ${fact}`);
  }
});
