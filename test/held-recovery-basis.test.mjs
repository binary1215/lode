import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session-host-request.mjs";
import { createRecoveryBasisMemory } from "../scripts/lib/recovery-basis-memory.mjs";
import { dispatch, entryHoldSession, initHoldSession, tools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

// 4-D part (b), user decision 4-2 (a): a Host-verified caller may omit
// expected_recovery_basis_id on lode_checkpoint_sync. Explicit ids, unverified
// callers and the CLI behave exactly as before.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const direction = {
  purpose: "Ship the held-basis save",
  approved_decisions: ["One call when verified"],
  current_position: "Tests",
  next_expected_result: "Green",
};

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-held-basis-")));
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
// A Codex caller is verified by its native threadId (the existing Host route).
const codex = (bridge, root, name, args, threadId) =>
  dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...(threadId ? { _meta: { threadId } } : {}), name, arguments: { project_root: root, ...args } } },
    { nativeSessionBridge: bridge },
  );
const value = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
};

test("schema: only the basis id leaves required; the default list keeps 22 tools", () => {
  const sync = tools.find((tool) => tool.name === "lode_checkpoint_sync");
  assert.deepEqual(sync.inputSchema.required, ["project_root", "purpose", "approved_decisions", "current_position", "next_expected_result"]);
  assert.ok(sync.inputSchema.properties.expected_recovery_basis_id);
  assert.equal(tools.length, 22);
});

test("verified caller: read the basis, then save in one call exactly as with the explicit id", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const basis = value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A")).basis;
  const saved = value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A"));
  assert.equal(saved.outcome, "created");
  assert.equal(saved.expectedBasisId, basis.basisId, "the held basis is used exactly as if passed");
  // The created sync hands out its resulting basis: the next save is one call too.
  const again = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, current_position: "Second save" }, "thread-A"));
  assert.equal(again.outcome, "created");
  assert.equal(again.expectedBasisId, saved.resultingBasis.basisId);
  // An identical retry converges ("reused") and keeps what is held.
  const reused = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, current_position: "Second save" }, "thread-A"));
  assert.equal(reused.outcome, "reused");
  // "reused" keeps what is held: a further changed save is still one call.
  const after = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, current_position: "Third save" }, "thread-A"));
  assert.equal(after.outcome, "created");
  assert.equal(after.expectedBasisId, again.resultingBasis.basisId);

  // Same outcome as the explicit-id call on a twin Project.
  const twin = fixture(t);
  const twinBridge = createNativeSessionHostBridge({ runtime: "codex", environment: twin.environment });
  t.after(() => twinBridge.dispose());
  const twinBasis = value(await codex(twinBridge, twin.root, "lode_checkpoint_basis", {}, "thread-A")).basis;
  const explicit = value(
    await codex(twinBridge, twin.root, "lode_checkpoint_sync", { ...direction, expected_recovery_basis_id: twinBasis.basisId }, "thread-A"),
  );
  const shape = (result) => ({
    status: result.status,
    outcome: result.outcome,
    writes: result.writes,
    persisted: result.persisted,
    reasonCode: result.reasonCode,
  });
  const first = fixture(t);
  const firstBridge = createNativeSessionHostBridge({ runtime: "codex", environment: first.environment });
  t.after(() => firstBridge.dispose());
  value(await codex(firstBridge, first.root, "lode_checkpoint_basis", {}, "thread-A"));
  assert.deepEqual(shape(value(await codex(firstBridge, first.root, "lode_checkpoint_sync", direction, "thread-A"))), shape(explicit));
});

test("a state change in between conflicts like a stale explicit id, writes nothing, and the retry is refused", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const stale = value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A")).basis.basisId;
  // Another caller changes the Session's recovery state meanwhile.
  const otherBasis = value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-B")).basis.basisId;
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, purpose: "B wins first" }, "thread-B")).outcome, "created");
  assert.equal(otherBasis, stale);

  const before = snapshot(root);
  const held = value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A"));
  const explicit = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, expected_recovery_basis_id: stale }, "thread-C"));
  assert.equal(held.outcome, "conflict");
  assert.equal(held.expectedBasisId, stale);
  assert.deepEqual(
    { outcome: held.outcome, reasonCode: held.reasonCode, writes: held.writes, persisted: held.persisted },
    { outcome: explicit.outcome, reasonCode: explicit.reasonCode, writes: explicit.writes, persisted: explicit.persisted },
  );
  assert.deepEqual(snapshot(root), before, "a conflict writes nothing");
  // A conflict drops the held basis: repeating the same call cannot win by retry.
  const retried = await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A");
  assert.equal(retried.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  assert.match(retried.error.message, /lode_checkpoint_basis/u);
  assert.deepEqual(snapshot(root), before);
});

test("nothing held: verified callers get the basis-read refusal; unverified callers keep today's refusal; nothing is written", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const before = snapshot(root);
  const verified = await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A");
  assert.equal(verified.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  assert.match(verified.error.message, /^No recovery basis is held for this caller and Session\. Call lode_checkpoint_basis/u);
  // Unverified: no native metadata on the call (after the transport saw it once),
  // and no native bridge at all.
  const unverified = await codex(bridge, root, "lode_checkpoint_sync", direction, null);
  const plain = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "lode_checkpoint_sync", arguments: { project_root: root, ...direction } },
  });
  // A Codex bridge that has never seen native metadata (legacy transport), and an
  // unverified call with an explicit Session route: today's argument refusal.
  const legacyBridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => legacyBridge.dispose());
  const legacy = await codex(legacyBridge, root, "lode_checkpoint_sync", direction, null);
  const sessionId = value(await codex(bridge, root, "lode_session_create", { purpose: "Explicit route" }, "thread-A")).sessionId;
  const before2 = snapshot(root);
  const routedUnverified = await codex(bridge, root, "lode_checkpoint_sync", { ...direction, session_id: sessionId }, null);
  for (const response of [plain, legacy, routedUnverified]) {
    assert.equal(response.error?.message, "Expected recovery basis id is required.", JSON.stringify(response));
    assert.equal(response.error.data.reasonCode, "INVALID_COMPACTION_INPUT");
  }
  assert.deepEqual(snapshot(root), before2);
  // Today's unverified-caller result on a native transport (unchanged from main):
  // the Session-dependent call is unresolved, nothing is published.
  assert.equal(unverified.error, undefined);
  assert.equal(unverified.result.structuredContent.status, "session_selection_unresolved");
  assert.equal(unverified.result.structuredContent.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE");
  assert.deepEqual(snapshot(root), before2);
});

test("a diagnosis does not arm the held basis, and one caller's basis is never used for another", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_checkpoint_diagnose", {}, "thread-A"));
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A"));
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-B")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("a held basis is per logical Session: another Session of the same caller does not use it", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const other = value(await codex(bridge, root, "lode_session_create", { purpose: "Second line of work" }, "thread-A")).sessionId;
  value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A"));
  const refused = await codex(bridge, root, "lode_checkpoint_sync", { ...direction, session_id: other }, "thread-A");
  assert.equal(refused.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
});

test("verified Claude caller (hook-prepared) saves in one call; without the hook preparation it keeps today's behaviour", async (t) => {
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
  value(await call("lode_checkpoint_basis", {}, "basis"));
  const before = snapshot(root);
  // No hook preparation: the caller is unverified, so the held basis is not used.
  const unprepared = await call("lode_checkpoint_sync", direction, "sync-unprepared", false);
  assert.equal(unprepared.error, undefined);
  assert.equal(unprepared.result.structuredContent.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE", "unverified: today's behaviour, no held basis");
  assert.deepEqual(snapshot(root), before);
  assert.equal(value(await call("lode_checkpoint_sync", direction, "sync")).outcome, "created");
});

test("memory bound: entries beyond the size bound are dropped; there is no age bound", () => {
  const memory = createRecoveryBasisMemory({ maxEntries: 2 });
  const a = memory.forCaller("caller-a");
  a.hold("/p", "s1", "recovery-basis-000000000000000000000001");
  a.hold("/p", "s2", "recovery-basis-000000000000000000000002");
  a.hold("/p", "s3", "recovery-basis-000000000000000000000003");
  assert.equal(a.held("/p", "s1"), null, "the oldest entry is dropped beyond the size bound");
  assert.equal(a.held("/p", "s3"), "recovery-basis-000000000000000000000003");
  assert.equal(memory.forCaller("caller-b").held("/p", "s3"), null, "per caller");
  assert.deepEqual(Object.keys(memory.describe()).sort(), ["authorityPlane", "entries", "maxEntries", "persisted", "recoveryAuthority"]);
});

test("only the native bridge supplies a held basis: an embedder option is ignored with or without a bridge", async (t) => {
  const { root, environment } = fixture(t);
  const embedded = createRecoveryBasisMemory().forCaller("embedder");
  const plain = (name, args, options) =>
    dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } }, options);
  const basis = value(await plain("lode_checkpoint_basis", {}, { recoveryBasisMemory: embedded })).basis;
  embedded.hold(root, basis.sessionId, basis.basisId);
  const before = snapshot(root);
  const noBridge = await plain("lode_checkpoint_sync", direction, { recoveryBasisMemory: embedded });
  assert.equal(noBridge.error?.message, "Expected recovery basis id is required.", JSON.stringify(noBridge));
  assert.equal(noBridge.error.data.reasonCode, "INVALID_COMPACTION_INPUT");
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const viaBridge = await plain("lode_checkpoint_sync", direction, { nativeSessionBridge: bridge, recoveryBasisMemory: embedded });
  assert.equal(viaBridge.error?.message, "Expected recovery basis id is required.");
  assert.deepEqual(snapshot(root), before);
});

test("a verified caller on an uninitialized directory gets the operation's own refusal, as on main", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-held-basis-empty-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: path.join(base, "host") } });
  t.after(() => bridge.dispose());
  const response = await codex(bridge, base, "lode_checkpoint_sync", direction, "thread-A");
  assert.equal(response.error?.message, "Expected recovery basis id is required.", JSON.stringify(response));
  assert.deepEqual(
    fs.readdirSync(base).filter((name) => name !== "host"),
    [],
  );
});

test("CLI is unchanged: the basis id is still required", async (t) => {
  const { base, root } = fixture(t);
  const input = path.join(base, "sync.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      purpose: direction.purpose,
      approvedDecisions: direction.approved_decisions,
      currentPosition: direction.current_position,
      nextExpectedResult: direction.next_expected_result,
    }),
  );
  await assert.rejects(runCommand(["checkpoint-sync", root, "--input", input]), (error) => {
    assert.equal(error.code, "INVALID_COMPACTION_INPUT");
    assert.equal(error.message, "Expected recovery basis id is required.");
    return true;
  });
});

// 4-D (b2): a verified caller's successful entry holds a basis too.
test("verified entry, work, then one-call save with zero refusals, equal to the explicit-id save", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const entered = value(await codex(bridge, root, "lode_conversation_enter", {}, "thread-A"));
  assert.equal(entered.status, "conversation_ready");
  value(await codex(bridge, root, "lode_project_graph", { query: "README" }, "thread-A"));
  const saved = value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A"));
  assert.equal(saved.outcome, "created");
  const twin = fixture(t);
  const twinBridge = createNativeSessionHostBridge({ runtime: "codex", environment: twin.environment });
  t.after(() => twinBridge.dispose());
  const twinBasis = value(await codex(twinBridge, twin.root, "lode_checkpoint_basis", {}, "thread-A")).basis.basisId;
  const explicit = value(await codex(twinBridge, twin.root, "lode_checkpoint_sync", { ...direction, expected_recovery_basis_id: twinBasis }, "thread-A"));
  const shape = (result) => ({
    status: result.status,
    outcome: result.outcome,
    writes: result.writes,
    persisted: result.persisted,
    reasonCode: result.reasonCode,
  });
  assert.deepEqual(shape(saved), shape(explicit));
});

test("verified initialize-or-resume holds the basis of the Session it returned, including a first adoption", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  const resumed = value(await codex(bridge, root, "lode_project_initialize_or_resume", {}, "thread-A"));
  assert.equal(resumed.projectAction, "resumed");
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-held-basis-adopt-")));
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  const adopted = value(await codex(bridge, fresh, "lode_project_initialize_or_resume", { profile: "core", runtimes: ["codex"] }, "thread-A"));
  assert.equal(adopted.projectAction, "initialized");
  assert.equal(value(await codex(bridge, fresh, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("after entry, another caller's change conflicts like a stale explicit id and writes nothing", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_conversation_enter", {}, "thread-A"));
  const stale = value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-C")).basis.basisId;
  const other = value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-B")).basis.basisId;
  const first = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, purpose: "B first", expected_recovery_basis_id: other }, "thread-B"));
  assert.equal(first.outcome, "created");
  const before = snapshot(root);
  const held = value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A"));
  const explicit = value(await codex(bridge, root, "lode_checkpoint_sync", { ...direction, expected_recovery_basis_id: stale }, "thread-C"));
  assert.equal(held.outcome, "conflict");
  assert.deepEqual(
    { outcome: held.outcome, reasonCode: held.reasonCode, writes: held.writes },
    { outcome: explicit.outcome, reasonCode: explicit.reasonCode, writes: explicit.writes },
  );
  assert.deepEqual(snapshot(root), before);
});

test("the caller's own direction update after entry re-arms the held basis: the id-less save is created (part c)", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_conversation_enter", {}, "thread-A"));
  const update = { expected_direction_id: null, direction: { goal: "g", constraints: [], decisions: [], cancelledActions: [] } };
  assert.equal(value(await codex(bridge, root, "lode_project_direction_update", update, "thread-A")).status, "updated");
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("unverified entry holds nothing; entry holds per caller and per Session", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  value(await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_conversation_enter", arguments: { project_root: root } } }));
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  value(await codex(bridge, root, "lode_conversation_enter", {}, "thread-A"));
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-B")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  const other = value(await codex(bridge, root, "lode_session_create", { purpose: "Other work" }, "thread-A")).sessionId;
  const refused = await codex(bridge, root, "lode_checkpoint_sync", { ...direction, session_id: other }, "thread-A");
  assert.equal(refused.error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
  assert.equal(value(await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).outcome, "created");
});

test("entry hold decisions: only a ready entry for the basis Session, and init only for the exact returned state", () => {
  const basis = { sessionId: "s1", basisId: "recovery-basis-000000000000000000000001", sessionRecordHash: "h1", currentProjectDirectionId: "direction-1" };
  const ready = { status: "conversation_ready", projectStatus: { project: { sessionId: "s1" } } };
  assert.equal(entryHoldSession(ready, basis), "s1");
  assert.equal(entryHoldSession({ ...ready, status: "conversation_direction_restored" }, basis), "s1");
  for (const status of ["recovery_attention_required", "conversation_recovery_unavailable", "session_selection_unresolved"])
    assert.equal(entryHoldSession({ ...ready, status }, basis), null, status);
  assert.equal(entryHoldSession({ ...ready, projectStatus: { project: { sessionId: "s2" } } }, basis), null, "another Session");
  assert.equal(entryHoldSession({ status: "conversation_ready", workContext: { sessionId: "s1" } }, basis), "s1", "work context fallback");
  assert.equal(entryHoldSession(ready, null), null);

  const hash = (state) => state.hash;
  const init = { projectAction: "resumed", project: { sessionId: "s1" }, state: { hash: "h1" }, currentProjectDirection: { directionId: "direction-1" } };
  assert.equal(initHoldSession(init, basis, hash), "s1");
  assert.equal(initHoldSession({ ...init, projectAction: "initialized" }, basis, hash), "s1");
  assert.equal(initHoldSession({ ...init, state: { hash: "h2" } }, basis, hash), null, "a Session record change in between");
  assert.equal(initHoldSession({ ...init, currentProjectDirection: { directionId: "direction-2" } }, basis, hash), null, "a direction change in between");
  assert.equal(initHoldSession({ ...init, currentProjectDirection: null }, basis, hash), null);
  assert.equal(initHoldSession({ ...init, project: { sessionId: "s2" } }, basis, hash), null, "another Session");
  assert.equal(initHoldSession({ ...init, projectAction: "relocation_available" }, basis, hash), null);
  assert.equal(initHoldSession(init, null, hash), null);
});

test("a view the bridge issued for one request cannot be reused outside it", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  let captured = null;
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { _meta: { threadId: "thread-A" }, name: "lode_checkpoint_basis", arguments: { project_root: root } },
  };
  await bridge.dispatch(request, async (original, routing) => {
    captured = routing.recoveryBasisMemory;
    return dispatch(original, routing);
  });
  assert.ok(captured, "the verified request received a view");
  const before = snapshot(root);
  const reused = await dispatch(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lode_checkpoint_sync", arguments: { project_root: root, ...direction } } },
    { recoveryBasisMemory: captured },
  );
  assert.equal(reused.error?.message, "Expected recovery basis id is required.", JSON.stringify(reused));
  assert.deepEqual(snapshot(root), before);
});

test("an unverified entry on a native transport holds nothing", async (t) => {
  const { root, environment } = fixture(t);
  const bridge = createNativeSessionHostBridge({ runtime: "codex", environment });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_project_status", {}, "thread-A"));
  const unverified = value(await codex(bridge, root, "lode_conversation_enter", {}, null));
  assert.equal(unverified.status, "session_selection_unresolved");
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
});
