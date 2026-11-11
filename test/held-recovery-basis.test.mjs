import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "../scripts/lib/session-host-request.mjs";
import { createRecoveryBasisMemory } from "../scripts/lib/recovery-basis-memory.mjs";
import { dispatch, tools } from "../scripts/mcp-server.mjs";
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
  for (const response of [plain]) {
    assert.equal(response.error.message, "Expected recovery basis id is required.");
    assert.equal(response.error.data.reasonCode, "INVALID_COMPACTION_INPUT");
  }
  // Today's unverified-caller result on a native transport (unchanged from main):
  // the Session-dependent call is unresolved, nothing is published.
  assert.equal(unverified.error, undefined);
  assert.equal(unverified.result.structuredContent.status, "session_selection_unresolved");
  assert.equal(unverified.result.structuredContent.reasonCode, "NATIVE_SESSION_CALLER_UNAVAILABLE");
  assert.deepEqual(snapshot(root), before);
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

test("memory bounds: entries beyond the size or age bound are dropped, then the basis read is required again", () => {
  let time = 0;
  const memory = createRecoveryBasisMemory({ now: () => time, ttlMs: 10, maxEntries: 2 });
  const a = memory.forCaller("caller-a");
  a.hold("/p", "s1", "recovery-basis-000000000000000000000001");
  a.hold("/p", "s2", "recovery-basis-000000000000000000000002");
  a.hold("/p", "s3", "recovery-basis-000000000000000000000003");
  assert.equal(a.held("/p", "s1"), null, "the oldest entry is dropped beyond the size bound");
  assert.equal(a.held("/p", "s3"), "recovery-basis-000000000000000000000003");
  assert.equal(memory.forCaller("caller-b").held("/p", "s3"), null, "per caller");
  time = 11;
  assert.equal(a.held("/p", "s3"), null, "entries expire with age");
  assert.equal(memory.describe().persisted, false);
});

test("age bound through the real dispatch: an expired held basis is refused like nothing held", async (t) => {
  const { root, environment } = fixture(t);
  let time = 0;
  const bridge = createNativeSessionHostBridge({
    runtime: "codex",
    environment,
    recoveryBasisMemory: createRecoveryBasisMemory({ now: () => time, ttlMs: 5 }),
  });
  t.after(() => bridge.dispose());
  value(await codex(bridge, root, "lode_checkpoint_basis", {}, "thread-A"));
  time = 6;
  assert.equal((await codex(bridge, root, "lode_checkpoint_sync", direction, "thread-A")).error.data.reasonCode, "RECOVERY_BASIS_NOT_HELD");
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
