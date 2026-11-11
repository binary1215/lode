import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session-host-request.mjs";
import { createRecoveryBasisMemory } from "../scripts/lib/recovery-basis-memory.mjs";
import { inspectRecoveryCheckpointBasis, recoveryBasisIdWithDirection } from "../scripts/lib/compaction-recovery.mjs";
import { dispatch, reArmedBasisId, tools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

// 4-D part (c): a Host-verified caller may omit expected_direction_id when a
// direction id is held for it (D1), and its own direction update re-arms the
// recovery bases it holds, so the first save after it is not refused as a
// conflict (user rule, 2026-11-11). Unverified callers and the CLI are unchanged.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const direction = {
  purpose: "Ship the held direction id",
  approved_decisions: ["Re-arm after the caller's own update"],
  current_position: "Tests",
  next_expected_result: "Green",
};
const goal = (text) => ({ direction: { goal: text, constraints: [], decisions: [], cancelledActions: [] } });

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-held-direction-")));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host"), LODE_SUBAGENT_WRITE_GUARD: "off" };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, environment };
}
function snapshot(root) {
  return fs
    .readdirSync(root, { recursive: true })
    .filter((entry) => fs.statSync(path.join(root, entry)).isFile())
    .sort()
    .map((entry) => [entry, fs.readFileSync(path.join(root, entry), "utf8")]);
}
const codex = (bridge, root, name, args, threadId) =>
  dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...(threadId ? { _meta: { threadId } } : {}), name, arguments: { project_root: root, ...args } } },
    { nativeSessionBridge: bridge },
  );
// No bridge at all: an unverified caller, and it never touches held values.
const plain = (root, name, args) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } });
const value = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
};
const reason = (response) => response.error?.data?.reasonCode;
function codexFixture(t) {
  const fixed = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment: fixed.environment });
  t.after(() => bridge.dispose());
  return { ...fixed, bridge, call: (name, args, thread) => codex(bridge, fixed.root, name, args, thread) };
}

test("schema: expected_direction_id leaves required and stays declared; the description says when it may be omitted", () => {
  const update = tools.find((tool) => tool.name === "lode_project_direction_update");
  assert.deepEqual(update.inputSchema.required, ["project_root", "direction"]);
  assert.deepEqual(update.inputSchema.properties.expected_direction_id, { type: ["string", "null"] });
  assert.match(update.description, /Host-verified caller may omit expected_direction_id/u);
});

test("basis id with a substituted direction: the same direction gives the same id, another gives another", (t) => {
  const { root } = fixture(t);
  const basis = inspectRecoveryCheckpointBasis({ root }).basis;
  assert.equal(recoveryBasisIdWithDirection(basis, basis.currentProjectDirectionId), basis.basisId);
  assert.notEqual(recoveryBasisIdWithDirection(basis, "direction-000000000000000000000000"), basis.basisId);
});

test("re-arm decision: only when the basis carries the returned direction and is otherwise the held one", (t) => {
  const { root } = fixture(t);
  const basis = inspectRecoveryCheckpointBasis({ root }).basis;
  const updated = { directionId: basis.currentProjectDirectionId, previousDirectionId: "direction-000000000000000000000001" };
  const held = recoveryBasisIdWithDirection(basis, updated.previousDirectionId);
  assert.equal(reArmedBasisId(held, basis, updated, recoveryBasisIdWithDirection), basis.basisId);
  // Another update landed after this one: the basis carries another direction.
  const later = { ...updated, directionId: "direction-000000000000000000000002" };
  assert.equal(reArmedBasisId(recoveryBasisIdWithDirection(basis, later.previousDirectionId), basis, later, recoveryBasisIdWithDirection), null);
  // Anything else changed: the substituted payload is not the held one.
  assert.equal(reArmedBasisId("recovery-basis-000000000000000000000000", basis, updated, recoveryBasisIdWithDirection), null);
  assert.equal(reArmedBasisId(null, basis, updated, recoveryBasisIdWithDirection), null);
});

test("D1: a verified caller omits the direction id it holds; conflicts drop it; explicit values and unverified callers are unchanged", async (t) => {
  const { root, environment } = fixture(t);
  const memory = createRecoveryBasisMemory();
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment, recoveryBasisMemory: memory });
  t.after(() => bridge.dispose());
  const call = (name, args, thread) => codex(bridge, root, name, args, thread);
  const heldA = () => memory.forCaller(JSON.stringify(["codex", "thread-A", null])).heldDirection(root);
  const first = value(await plain(root, "lode_project_direction_update", { expected_direction_id: null, ...goal("first") }));
  // Unverified omission keeps today's meaning (no current direction): conflict.
  assert.equal(reason(await plain(root, "lode_project_direction_update", goal("x"))), "PROJECT_DIRECTION_CONFLICT");
  // Nothing held yet for the verified caller: the same meaning.
  assert.equal(reason(await call("lode_project_direction_update", goal("x"), "thread-A")), "PROJECT_DIRECTION_CONFLICT");
  // A status result hands the caller the current direction id.
  value(await call("lode_project_status", {}, "thread-A"));
  const second = value(await call("lode_project_direction_update", goal("second"), "thread-A"));
  assert.equal(second.status, "updated");
  assert.equal(second.direction.previousDirectionId, first.direction.directionId);
  // Its own update hands it the new id: the next omitted update uses it.
  const third = value(await call("lode_project_direction_update", goal("third"), "thread-A"));
  assert.equal(third.direction.previousDirectionId, second.direction.directionId);
  // Explicit null is untouched even while an id is held.
  assert.equal(reason(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("y") }, "thread-A")), "PROJECT_DIRECTION_CONFLICT");
  // Any direction conflict, explicit ones included, drops the held id; a status read hands it again.
  assert.equal(heldA(), null);
  value(await call("lode_project_status", {}, "thread-A"));
  assert.equal(heldA(), third.direction.directionId);
  // Per caller: thread-B holds nothing.
  assert.equal(reason(await call("lode_project_direction_update", goal("y"), "thread-B")), "PROJECT_DIRECTION_CONFLICT");
  // Another caller moves the direction: A's held id is stale, conflicts, and is dropped.
  value(await plain(root, "lode_project_direction_update", { expected_direction_id: third.direction.directionId, ...goal("fourth") }));
  const before = snapshot(root);
  assert.equal(heldA(), third.direction.directionId);
  assert.equal(reason(await call("lode_project_direction_update", goal("mine"), "thread-A")), "PROJECT_DIRECTION_CONFLICT");
  assert.deepEqual(snapshot(root), before);
  assert.equal(heldA(), null, "the conflict dropped the held direction id");
  // Dropped: omission is back to its existing meaning until a result hands an id again.
  assert.equal(reason(await call("lode_project_direction_update", goal("mine"), "thread-A")), "PROJECT_DIRECTION_CONFLICT");
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  assert.equal(value(await call("lode_project_direction_update", goal("mine"), "thread-A")).status, "updated");
});

test("held, own update, id-less sync: created in one call, exactly as an explicit-id sync with the post-update basis", async (t) => {
  const { root, call } = codexFixture(t);
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  const update = await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A");
  // The update result is the ordinary one: no extra field, no metadata.
  assert.deepEqual(Object.keys(update.result).sort(), ["content", "structuredContent"]);
  assert.deepEqual(Object.keys(update.result.structuredContent).sort(), ["direction", "status"]);
  assert.deepEqual(JSON.parse(update.result.content[0].text), update.result.structuredContent);
  const after = value(await plain(root, "lode_checkpoint_basis", {})).basis;
  const saved = value(await call("lode_checkpoint_sync", direction, "thread-A"));
  assert.equal(saved.outcome, "created");
  assert.equal(saved.expectedBasisId, after.basisId, "re-armed to the post-update basis");

  const twin = codexFixture(t);
  value(await twin.call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  const twinBasis = value(await plain(twin.root, "lode_checkpoint_basis", {})).basis;
  const explicit = value(await twin.call("lode_checkpoint_sync", { ...direction, expected_recovery_basis_id: twinBasis.basisId }, "thread-A"));
  const shape = (result) => ({
    status: result.status,
    outcome: result.outcome,
    writes: result.writes,
    persisted: result.persisted,
    reasonCode: result.reasonCode,
  });
  assert.deepEqual(shape(saved), shape(explicit));
});

test("held, another caller's save, own update, id-less sync: conflict, nothing written, held basis dropped", async (t) => {
  const { root, call } = codexFixture(t);
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  value(await call("lode_checkpoint_basis", {}, "thread-B"));
  assert.equal(value(await call("lode_checkpoint_sync", { ...direction, current_position: "B saved" }, "thread-B")).outcome, "created");
  assert.equal(value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A")).status, "updated");
  const before = snapshot(root);
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-A")).outcome, "conflict");
  assert.deepEqual(snapshot(root), before);
  assert.equal(reason(await call("lode_checkpoint_sync", direction, "thread-A")), "RECOVERY_BASIS_NOT_HELD");
});

test("held, own update, another caller's save, id-less sync: conflict", async (t) => {
  const { root, call } = codexFixture(t);
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  value(await call("lode_checkpoint_basis", {}, "thread-B"));
  assert.equal(value(await call("lode_checkpoint_sync", { ...direction, current_position: "B saved" }, "thread-B")).outcome, "created");
  const before = snapshot(root);
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-A")).outcome, "conflict");
  assert.deepEqual(snapshot(root), before);
});

test("held, another caller's update, own update with the new explicit id, id-less sync: conflict", async (t) => {
  const { root, call } = codexFixture(t);
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  const other = value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("theirs") }, "thread-B"));
  const mine = await call("lode_project_direction_update", { expected_direction_id: other.direction.directionId, ...goal("mine") }, "thread-A");
  assert.equal(value(mine).status, "updated");
  const before = snapshot(root);
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-A")).outcome, "conflict");
  assert.deepEqual(snapshot(root), before);
});

test("nothing held, own update, id-less sync: RECOVERY_BASIS_NOT_HELD (nothing is created)", async (t) => {
  const { call } = codexFixture(t);
  value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  assert.equal(reason(await call("lode_checkpoint_sync", direction, "thread-A")), "RECOVERY_BASIS_NOT_HELD");
});

test("an update re-arms only its own caller's bases, for every Session that caller holds, and never another caller's", async (t) => {
  const { call } = codexFixture(t);
  const second = value(await call("lode_session_create", { purpose: "Second line of work" }, "thread-A")).sessionId;
  const third = value(await call("lode_session_create", { purpose: "Not held" }, "thread-A")).sessionId;
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  value(await call("lode_checkpoint_basis", { session_id: second }, "thread-A"));
  value(await call("lode_checkpoint_basis", {}, "thread-B"));
  value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-B")).outcome, "conflict", "B is not re-armed");
  assert.equal(reason(await call("lode_checkpoint_sync", { ...direction, session_id: third }, "thread-A")), "RECOVERY_BASIS_NOT_HELD", "no new entry");
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
  assert.equal(value(await call("lode_checkpoint_sync", { ...direction, session_id: second }, "thread-A")).outcome, "created");
});

test("a reused update keeps the held basis; a conflicting update leaves it as it was", async (t) => {
  const { call } = codexFixture(t);
  const first = value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  value(await call("lode_checkpoint_basis", {}, "thread-A"));
  assert.equal(
    value(await call("lode_project_direction_update", { expected_direction_id: first.direction.directionId, ...goal("g") }, "thread-A")).status,
    "reused",
  );
  assert.equal(reason(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("h") }, "thread-A")), "PROJECT_DIRECTION_CONFLICT");
  assert.equal(value(await call("lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("a failed basis read while re-arming leaves that entry as it was and does not fail the update", async (t) => {
  const { root, environment } = fixture(t);
  const memory = createRecoveryBasisMemory();
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment, recoveryBasisMemory: memory });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A"));
  // A held entry for a Session that cannot be routed.
  const view = memory.forCaller(JSON.stringify(["codex", "thread-A", null]));
  view.hold(root, "session-00000000-0000-0000-0000-000000000000", "recovery-basis-000000000000000000000000");
  const update = value(await codex(bridge, root, "lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "thread-A"));
  assert.equal(update.status, "updated");
  assert.equal(view.held(root, "session-00000000-0000-0000-0000-000000000000"), "recovery-basis-000000000000000000000000");
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("Claude: with hook preparation the update re-arms; without it, or when preparation fails, everything is as on main", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => bridge.dispose());
  const wire = (name, args, id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { _meta: { "claudecode/toolUseId": id }, name, arguments: { project_root: root, ...args } },
  });
  const hook = (request) => ({
    jsonrpc: "2.0",
    id: "hook",
    method: "tools/call",
    params: {
      name: SESSION_HOST_REQUEST_HELPER,
      arguments: {
        native_session_id: "claude-session",
        native_agent_id: "",
        tool_use_id: request.params._meta["claudecode/toolUseId"],
        outer_tool_name: "mcp__lode__" + request.params.name,
        original_arguments: JSON.stringify(request.params.arguments),
      },
    },
  });
  const call = async (name, args, id, prepared = true) => {
    const request = wire(name, args, id);
    if (prepared) assert.equal((await dispatch(hook(request), { nativeSessionBridge: bridge })).result.isError, undefined);
    return dispatch(request, { nativeSessionBridge: bridge });
  };
  value(await call("lode_project_initialize_or_resume", {}, "init"));
  // Without preparation: unverified, so no re-arm and the held basis conflicts.
  value(await call("lode_checkpoint_basis", {}, "basis-1"));
  assert.equal(value(await call("lode_project_direction_update", { expected_direction_id: null, ...goal("g") }, "update-1", false)).status, "updated");
  assert.equal(value(await call("lode_checkpoint_sync", direction, "sync-1")).outcome, "conflict");
  // Preparation that fails (the tool use id is already spent): the hook still
  // answers without an error and the update runs unverified, as on main.
  value(await call("lode_checkpoint_basis", {}, "basis-2"));
  const spent = wire("lode_project_direction_update", goal("h"), "basis-2");
  assert.equal((await dispatch(hook(spent), { nativeSessionBridge: bridge })).result.isError, undefined);
  const current = value(await plain(root, "lode_project_direction_read", {})).directionId;
  assert.equal(
    value(await dispatch(wire("lode_project_direction_update", { expected_direction_id: current, ...goal("h") }, "basis-2"), { nativeSessionBridge: bridge }))
      .status,
    "updated",
  );
  assert.equal(value(await call("lode_checkpoint_sync", direction, "sync-2")).outcome, "conflict");
  // With preparation: verified, it may omit the held direction id, and it re-arms.
  value(await call("lode_checkpoint_basis", {}, "basis-3"));
  assert.equal(value(await call("lode_project_direction_update", goal("i"), "update-3")).status, "updated");
  assert.equal(value(await call("lode_checkpoint_sync", direction, "sync-3")).outcome, "created");
});

test("CLI is unchanged: an omitted expected direction still means no current direction", async (t) => {
  const { base, root } = fixture(t);
  const input = path.join(base, "direction.json");
  fs.writeFileSync(input, JSON.stringify(goal("g").direction));
  assert.equal((await runCommand(["project-direction-update", root, "--input", input])).status, "updated");
  fs.writeFileSync(input, JSON.stringify(goal("h").direction));
  await assert.rejects(runCommand(["project-direction-update", root, "--input", input]), (error) => error.code === "PROJECT_DIRECTION_CONFLICT");
});
