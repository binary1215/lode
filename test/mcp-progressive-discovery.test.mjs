import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dispatch, discoverTools, tools, catalogTools } from "../scripts/mcp-server.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { sessionStatePath } from "../scripts/lib/session-routing.mjs";
import { runCommand, usage } from "../scripts/head.mjs";
const pluginRoot = path.resolve(import.meta.dirname, "..");
const request = (name, args = {}) => ({ id: 1, method: "tools/call", params: { name, arguments: args } });
const call = (name, args = {}, options) => dispatch(request(name, args), options);
function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "head-progressive-"));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
    const file = path.join(root, e.name);
    return e.isDirectory() ? snapshot(file) : [[file, fs.readFileSync(file).toString("base64")]];
  });
}

test("an absent common direction remains null text, not invalid MCP structuredContent or approved empty state", async t => {
  const {root,layout}=fixture(t),before=snapshot(root);
  for(const [name,args]of [["lode_project_direction_read",{project_root:root}],
    ["lode_tools_read",{name:"lode_project_direction_read",arguments:{project_root:root}}]]){
    const response=await call(name,args);
    assert.equal(response.error,undefined);
    assert.equal(response.result.isError,undefined);
    assert.equal(Object.hasOwn(response.result,"structuredContent"),false);
    assert.equal(response.result.content[0].text,"null");
  }
  assert.deepEqual(snapshot(root),before);
});

test("small default catalog discovers every ordinary contract without registering, unlocking or initializing", async () => {
  assert.equal(tools.length, 20);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "lode_core_contract", "lode_project_status", "lode_project_initialize_or_resume",
    "lode_runtime_invocation_lease_status", "lode_pending_review", "lode_checkpoint_basis",
    "lode_checkpoint_diagnose", "lode_checkpoint_sync", "lode_session_restore",
    "lode_worker_integration_status", "lode_bounded_worker_job_status", "lode_bounded_worker_cancel",
    "lode_conversation_enter", "lode_project_graph", "lode_session_host_request_prepare",
    "lode_session_create", "lode_project_direction_update", "lode_tools_discover", "lode_tools_read", "lode_tools_call",
  ].sort());
  for (const name of ["lode_session_create", "lode_project_direction_update", "lode_checkpoint_sync"]) {
    const descriptor = tools.find(tool => tool.name === name);
    assert.strictEqual(descriptor, catalogTools.find(tool => tool.name === name));
    assert.equal(descriptor.inputSchema.properties.session_id.type, "string");
    assert.deepEqual(descriptor.annotations, { readOnlyHint: false,
      destructiveHint: name !== "lode_session_create", idempotentHint: name !== "lode_session_create", openWorldHint: false });
  }
  assert.equal(tools.find(tool => tool.name === "lode_tools_call").annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === "lode_tools_call").annotations.openWorldHint, true);
  assert(tools.some(tool => tool.name === "lode_session_host_request_prepare"));
  assert(tools.some(tool => tool.name === "lode_project_graph"));
  assert(Buffer.byteLength(JSON.stringify(tools)) < 112030 / 2);
  for (const name of ["head_operating_lane_recommend", "head_product_note", "lode_context_prepare", "lode_world_model"]) {
    assert(!tools.some(tool => tool.name === name));
  }
  const groups = (await call("lode_tools_discover")).result.structuredContent;
  assert.equal(groups.persisted, false); assert.equal(groups.grantsAuthorization, false);
  const found = [];
  for (const { prefix } of groups.prefixes) {
    let offset = 0;
    do {
      const page = (await call("lode_tools_discover", { prefix, offset, limit: 2 })).result.structuredContent;
      found.push(...page.tools); offset = page.nextOffset;
    } while (offset != null);
  }
  assert.deepEqual(found.map(x => x.name).sort(), catalogTools.map(x => x.name).sort());
  for (const tool of found) {
    assert.deepEqual(tool.inputSchema, catalogTools.find(x => x.name === tool.name).inputSchema);
    assert.equal(tool.invokeWith, tool.annotations.readOnlyHint ? "lode_tools_read" : "lode_tools_call");
  }
  assert.equal(discoverTools({ prefix: "compatibility" }).tools.length, 0);
  for (const name of ["head_operating_lane_recommend", "head_product_note", "head_metric_follow_up", "head_observation_status", "head_observation_collect"]) {
    assert.throws(() => discoverTools({ name }), /Unknown or unavailable tool/);
    assert((await call(name, {})).error, name);
    assert((await call("lode_tools_call", { name, arguments: {} })).error, name);
    assert(!usage({ all: true }).commands.some(command => command.split(/\s+/)[1] === name.replace(/^head_/, "").replaceAll("_", "-")));
  }
  assert((await call("lode_tools_discover", { name: "head_product_note", prefix: "head_" })).error);
});

test("ordinary typed Session creation and compatible router share no-clobber retry and rejection", async t => {
  const { root, storage, layout } = fixture(t), defaultId = inspectProject(root).state.sessionId;
  const original = fs.readFileSync(sessionStatePath(root, storage));
  const args = { project_root: root, new_session_id: "session-00000000-0000-4000-8000-000000000001", purpose: "Independent synthetic work" };
  const first = await call("lode_session_create", args);
  assert.equal(first.error, undefined);
  assert.equal(first.result.structuredContent.status, "created");
  const routed = await call("lode_tools_call", { name: "lode_session_create", arguments: args });
  assert.equal(routed.result.structuredContent.status, "existing");
  assert.deepEqual(await call("lode_session_create", args), routed);
  assert.equal(inspectProject(root).state.sessionId, defaultId);
  assert.deepEqual(fs.readFileSync(sessionStatePath(root, storage)), original);
  const before = snapshot(root), divergent = { ...args, purpose: "Different purpose" };
  const directError = await call("lode_session_create", divergent);
  assert(directError.error);
  assert.deepEqual(await call("lode_tools_call", { name: "lode_session_create", arguments: divergent }), directError);
  assert.match((await call("lode_tools_read", { name: "lode_session_create", arguments: args })).error.message, /not read-only/);
  assert.deepEqual(snapshot(root), before);
});

test("ordinary direction updates retain replacement, current-basis conflicts and router parity", async t => {
  const { root, layout } = fixture(t);
  const initial = { project_root: root, expected_direction_id: null,
    direction: { goal: "Synthetic local work", constraints: ["Read only"], decisions: [], cancelledActions: ["deploy"] } };
  const first = await call("lode_project_direction_update", initial);
  assert.equal(first.error, undefined);
  const old = first.result.structuredContent.direction;
  const revisionDir = path.join(root, layout.directory, "project-direction/revisions");
  const originalRevisions = snapshot(revisionDir);
  const replacement = { ...initial, expected_direction_id: old.directionId,
    direction: { goal: "Synthetic approved local edits", constraints: [], decisions: ["Local edits allowed"], cancelledActions: [] } };
  const second = await call("lode_project_direction_update", replacement);
  assert.equal(second.error, undefined);
  assert.equal(second.result.structuredContent.status, "updated");
  assert.deepEqual(second.result.structuredContent.direction.input.cancelledActions, []);
  assert.deepEqual(second.result.structuredContent.direction.input.constraints, []);
  assert.equal(second.result.structuredContent.direction.grantsExecutionAuthorization, false);
  for (const [file, bytes] of originalRevisions) assert.equal(fs.readFileSync(file).toString("base64"), bytes);
  const retried = await call("lode_tools_call", { name: "lode_project_direction_update", arguments: replacement });
  assert.equal(retried.result.structuredContent.status, "reused");
  assert.deepEqual(await call("lode_project_direction_update", replacement), retried);
  const before = snapshot(root), stale = { ...replacement, expected_direction_id: null };
  const directError = await call("lode_project_direction_update", stale);
  assert(directError.error);
  assert.deepEqual(await call("lode_tools_call", { name: "lode_project_direction_update", arguments: stale }), directError);
  assert.match((await call("lode_tools_read", { name: "lode_project_direction_update", arguments: replacement })).error.message, /not read-only/);
  assert.deepEqual(snapshot(root), before);
});

test("independent default operations do not require optional Host binding; explicit routes still validate", async t => {
  const { root, layout } = fixture(t), defaultId = inspectProject(root).state.sessionId;
  let resolutions = 0;
  const options = { resolveSessionContext() { resolutions++; throw Object.assign(new Error("Synthetic unavailable binding"), { code: "HEAD_SESSION_CONTEXT_UNAVAILABLE" }); } };
  const args = { project_root: root, new_session_id: "session-00000000-0000-4000-8000-000000000002", purpose: "Independent work" };
  assert.equal((await call("lode_session_create", args, options)).error, undefined);
  assert.equal(resolutions, 0);
  const explicit = await call("lode_session_create", { ...args, session_id: defaultId }, options);
  assert.equal(explicit.error, undefined);
  assert.equal(explicit.result.structuredContent.status, "existing");
  assert.equal(explicit.result._meta.headSessionBinding.status, "unavailable");
  const before = snapshot(root);
  const {root: foreign} = fixture(t), foreignId = inspectProject(foreign).state.sessionId;
  for (const session_id of [42, "session-00000000-0000-4000-8000-000000000003", foreignId]) {
    const invalid = { ...args, session_id, new_session_id: "session-00000000-0000-4000-8000-000000000004" };
    assert((await call("lode_session_create", invalid, options)).error);
    assert.deepEqual(snapshot(root), before);
  }
});

test("direct small work, optional context, status and recovery preserve authority without advisory tools", async t => {
  const { root, layout } = fixture(t);
  const before = snapshot(root);
  const status = await call("lode_project_status", { project_root: root });
  assert.equal(status.error, undefined);
  assert.equal(status.result.structuredContent.readiness.core.state, "ready");
  fs.writeFileSync(path.join(root, "small.txt"), "direct work\n");
  assert.equal(fs.readFileSync(path.join(root, "small.txt"), "utf8"), "direct work\n");
  assert.deepEqual(snapshot(root).filter(([file]) => file !== path.join(root, "small.txt")), before);
  const current = snapshot(root), task = "Prepare reproducible selected context for handoff";
  for (const [name, args] of [["lode_context_prepare", { project_root: root, task }],
    ["lode_checkpoint_diagnose", { project_root: root }]]) {
    const direct = await call(name, args);
    const routed = await call("lode_tools_read", { name, arguments: args });
    assert.deepEqual(routed, direct);
  }
  assert.deepEqual(snapshot(root), current);
  assert.equal(usage().contextPreparationRequired, false);
  assert(!usage().commands.some(command => /context-prepare|operating-lane-recommend|product-note/.test(command)));
  assert.equal(usage({ all: true }).compatibilityDiagnostics, undefined);
  const diagnosis = runCommand(["checkpoint-diagnose", root]);
  assert.equal(diagnosis.diagnosis.state, "no-current-checkpoint");
});

test("routed effects cannot masquerade as reads, enable maintenance, nest routers or evade original rejection", async t => {
  const { root, layout } = fixture(t), before = snapshot(root);
  const deniedRead = await call("lode_tools_read", { name: "lode_checkpoint_sync", arguments: { project_root: root } });
  assert.match(deniedRead.error.message, /not read-only/);
  const deniedManaged = await call("lode_tools_call", { name: "lode_bounded_worker_start", arguments: { project_root: root, surface: "managed-maintenance" } });
  assert.match(deniedManaged.error.message, /not available on the ordinary/);
  assert((await call("lode_tools_call", { name: "lode_tools_call", arguments: {} })).error);
  for (const name of ["lode_onboarding_review", "lode_checkpoint_sync", "lode_bounded_worker_cancel"]) {
    const args = { project_root: root };
    const direct = await call(name, args), routed = await call("lode_tools_call", { name, arguments: args });
    assert(direct.error, name); assert.deepEqual(routed, direct);
  }
  const explicit = await call("lode_tools_call", { name: "lode_bounded_worker_start", arguments: { project_root: root } }, { surface: "managed-maintenance" });
  assert(explicit.error); assert.doesNotMatch(explicit.error.message, /not available on the ordinary/);
  assert.deepEqual(snapshot(root), before);
});

test("cold catalog and Core contract avoid optional implementations and survive optional module failure", () => {
  const args = [path.join(pluginRoot, "test/helpers/mcp-loading-probe.mjs")];
  console.log(JSON.stringify({ event: "planned", command: process.execPath, args, parentPid: process.pid, cwd: pluginRoot, ports: [] }));
  const child = spawnSync(process.execPath, args, { cwd: pluginRoot, windowsHide: true, encoding: "utf8", timeout: 15000 });
  console.log(JSON.stringify({ event: "closed", pid: child.pid, parentPid: process.pid, exitCode: child.status, ports: [] }));
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.optionalFailureScoped, true); assert.equal(result.providerInvoked, false);
  console.log(JSON.stringify(result));
});

test("conversation onboarding discovers advanced schemas and exercises the advertised routes end to end", () => {
  const args = [path.join(pluginRoot, "scripts/verify-conversational-onboarding.mjs")];
  console.log(JSON.stringify({ event: "planned", command: process.execPath, args, parentPid: process.pid, cwd: pluginRoot, ports: [] }));
  const child = spawnSync(process.execPath, args, { cwd: pluginRoot, windowsHide: true, encoding: "utf8", timeout: 30000 });
  console.log(JSON.stringify({ event: "closed", pid: child.pid, parentPid: process.pid, exitCode: child.status, ports: [] }));
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.status, "conversational_onboarding_verified");
  assert.equal(result.defaultToolCount, tools.length);
  assert.equal(result.discoveryGrantsAuthorization, false);
  assert.equal(result.unconfirmedGraphDbActivationRejected, true);
  assert.equal(result.graphDbCredentialPreflightNetworkRequests, 0);
  assert.equal(result.worldGraphContextDocumentsReady, true);
  for (const name of ["lode_onboarding_guide", "lode_onboarding_review", "lode_markdown_projection_build",
    "lode_context_prepare", "lode_context_preview", "lode_graphdb_connection_preflight", "lode_graphdb_projection_activate"]) {
    assert(result.advancedToolsDiscovered.includes(name), name);
    assert(result.advancedToolsRouted.includes(name), name);
  }
});

test("static Core capability data keeps the same public contract without eager runtime/installation ownership", async () => {
  const standalone = await import("../scripts/lib/core-contract.mjs"), core = await import("../scripts/lib/lode-core.mjs");
  assert.strictEqual(core.coreContract, standalone.coreContract); assert.deepEqual(core.coreContract(), standalone.coreContract());
  const original = standalone.coreContract(); original.activeCapabilities.push("caller-local-only"); assert(!standalone.coreContract().activeCapabilities.includes("caller-local-only"));
  const direct = await call("lode_core_contract"); assert.equal(direct.error, undefined);
  const routed = await call("lode_tools_read", { name: "lode_core_contract", arguments: {} }); assert.deepEqual(routed, direct);
});
