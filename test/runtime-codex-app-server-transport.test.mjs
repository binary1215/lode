import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCodexAppServerTransport, createCodexAppServerProtocolFixtureTransport } from "../scripts/lib/runtime-codex-app-server-transport.mjs";
import { resolveVerifiedProcessSupervisor, verifyRuntimeProcessSupervisorHandle } from "../scripts/lib/runtime-process-supervisor.mjs";
import { finishCodexAppServerFixture } from "./helpers/codex-app-server-fixture-cleanup.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const realTimeout = setTimeout, realClearTimeout = clearTimeout;
function controlCleanupClock(t) {
  // Queue safety is not a benchmark of the OS scheduling a provider within
  // 66ms. Keep the exact grace policy; explicitly drive its clock separately.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A genuinely stuck fixture still drives the original three bounded phases
  // and fails. Read-only probes need no leaked raw owner/kill capability.
  let escalation;
  const advance = remaining => {
    t.mock.timers.tick(10000);
    if (remaining) escalation = realTimeout(() => advance(remaining - 1), 100);
  };
  const watchdog = realTimeout(() => advance(2), 5000);
  return () => { realClearTimeout(watchdog); realClearTimeout(escalation); t.mock.timers.reset(); };
}
function fixture(t, scenario = "normal", options = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "codex-rpc-"));
  const journal = [];
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: (process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT) || root });
  const config = { supervisorSelection: selection, executionRoot: dir, controlFile: path.join(dir, "control.jsonl"),
    providerEnvironment: process.env, terminationGraceMs: 200, sourceThreadId: "source",
    authorizationHash: hash("synthetic-authorization"), policyDigest: hash("synthetic-policy"), inputDigest: hash("synthetic-input"),
    recordOperationalEvidence: event => { journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); },
    scenario, ...options };
  const transport = createCodexAppServerProtocolFixtureTransport(config);
  const controller = new AbortController();
  const deadlineAt = Date.now() + 6000;
  const ownershipBinding = { authorizationHash: config.authorizationHash, policyDigest: config.policyDigest, inputDigest: config.inputDigest,
    executionRootDigest: hash(dir), consumptionId: "synthetic-consumption" };
  let handle = null;
  let externalOwner = null;
  const start = (signal = controller.signal) => { handle = transport.startFixture({ ownershipBinding, deadlineAt, signal }); return handle; };
  if (options.start !== false) start();
  t.after(async () => {
    const restoreClock = controlCleanupClock(t);
    try { await finishCodexAppServerFixture(externalOwner ? { ...externalOwner, dir }
      : { transport, owner: handle, journal, dir, allowUncleanClose: true }); }
    finally { restoreClock(); }
  });
  let sequence = 0;
  const request = (method = "thread/read", params = { threadId: "source", includeTurns: true }, extra = {}) => transport.request({
    requestId: `request-${sequence++}`, method, params, signal: controller.signal, deadlineAt, ...extra });
  // Configuration-only fixtures can lend their directory to a probe. Its exact
  // owner, not the never-started configuration transport, then owns teardown.
  const trackOwned = (transport, owner, journal, cleanup = {}) => {
    assert.equal(handle, null); assert.equal(externalOwner, null);
    externalOwner = { transport, owner, journal, ...cleanup };
  };
  return { transport, request, journal, controller, handle, config, ownershipBinding, deadlineAt, start, trackOwned };
}

// Observe the real native stdin boundary and all provider stdout, including
// output ignored by an already-closing transport. Never substitute RPC replies.
function observeWire(owner) {
  const writes = [];
  const original = owner.child.stdin.write;
  let stdout = "";
  owner.child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  owner.child.stdin.write = function (chunk, ...args) {
    try { writes.push(JSON.parse(chunk.toString())); } catch {}
    return original.call(this, chunk, ...args);
  };
  return { writes, branched: () => stdout.includes('"forkedFromId":"source"') };
}

for (const [scenario, params] of [
  ["installed-native", { ephemeral: true, deferGoalContinuation: true }],
  ["installed-native-paginated", { ephemeral: true, excludeTurns: false }],
]) test(`source-faithful ${scenario} rejects invalid fork before any child result`, async t => {
  const f = fixture(t, scenario);
  const wire = observeWire(f.handle);
  await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff", ...params }), { code: "CODEX_RPC_PROVIDER_ERROR" });
  assert.equal(wire.branched(), false);
  assert.equal(wire.writes.filter(frame => frame.method === "turn/start").length, 0);
});

for (const method of ["thread/goal/get", "thread/goal/clear", "thread/read"]) {
  test(`source-faithful ephemeral child rejects ${method} required by old native sequence`, async t => {
    const f = fixture(t, "installed-native");
    const forked = await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff", ephemeral: true });
    assert.equal(forked.thread.id, "child");
    await assert.rejects(f.request(method, { threadId: "child", ...(method === "thread/read" ? { includeTurns: true } : {}) }), { code: "CODEX_RPC_PROVIDER_ERROR" });
  });
}

for (const method of ["thread/goal/get", "thread/goal/clear"]) {
  test(`source-faithful disabled goals rejects ${method}, never returns null as proof`, async t => {
    const f = fixture(t, "installed-native-goals-disabled");
    await f.request("thread/fork", { threadId: "source", ephemeral: true });
    await assert.rejects(f.request(method, { threadId: "child" }), { code: "CODEX_RPC_PROVIDER_ERROR" });
  });
}

test("fixed actual constructor rejects incompatible fork locally without initialization or spawn", async t => {
  const f = fixture(t, "normal", { start: false });
  // Deliberately nonexistent target: construction and rejection must not run it.
  const transport = createCodexAppServerTransport({ ...f.config,
    executablePath: path.join(f.config.executionRoot, "codex.exe"), executableDigest: hash("never executed") });
  try {
    await assert.rejects(transport.request({ requestId: "invalid-fork", method: "thread/fork",
      params: { threadId: "source", ephemeral: true, deferGoalContinuation: true }, deadlineAt: f.deadlineAt }),
    { code: "CODEX_NATIVE_FORK_API_CONFLICT" });
    assert.equal(transport.inspect().started, false);
    assert.deepEqual(f.journal, []);
  } finally { await transport.close(); }
});

test("source-faithful paginated fork excludes turns and metadata reads remain usable", async t => {
  const f = fixture(t, "installed-native-paginated");
  const response = await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff", ephemeral: true, excludeTurns: true });
  assert.deepEqual(response.thread.turns, []);
  const read = await f.request("thread/read", { threadId: "child", includeTurns: false });
  assert.equal(read.thread.id, "child");
  assert.deepEqual(read.thread.turns, []);
  assert.equal(f.journal.some(event => event.method === "turn/start"), false);
});

for (const [action, code] of [["deadline", "CODEX_RPC_DEADLINE"], ["abort", "CODEX_RPC_CANCELLED"],
  ["close", "CODEX_RPC_TRANSPORT_CLOSED"], ["throw", "TEST_JOURNAL_FAILURE"]]) {
  test(`request journal ${action} cannot send a late fork or create a branch`, async t => {
    let f;
    let expires;
    f = fixture(t, "normal", { start: false, recordOperationalEvidence: event => {
      f.journal.push(event);
      if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event));
      if (event.event !== "request-sent" || event.method !== "thread/fork") return;
      if (action === "deadline") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, expires - Date.now() + 120));
      if (action === "abort") f.controller.abort();
      if (action === "close") f.transport.close().catch(() => {});
      if (action === "throw") throw Object.assign(new Error(code), { code });
    } });
    const owner = f.start();
    await f.request();
    const wire = observeWire(owner);
    expires = Date.now() + 100;
    await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }, { deadlineAt: expires }), { code });
    await f.transport.close().catch(() => {});
    assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 0);
    assert.equal(wire.branched(), false);
    const failed = f.journal.find(event => event.event === "request-failed" && event.method === "thread/fork");
    assert.equal(failed.state, "failed"); assert.equal(failed.writeAttempted, false);
    await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }));
    assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 0);
  });
}

for (const holdEof of [false, true]) for (const [action, code] of [["deadline", "CODEX_RPC_DEADLINE"], ["abort", "CODEX_RPC_CANCELLED"],
  ["write-failure", "TEST_BACKPRESSURE_FAILURE"]]) {
  test(`queued fork ${action} is rejected at the physical write boundary (${holdEof ? "held EOF" : "graceful EOF"})`, async t => {
    let queued;
    const enqueued = new Promise(resolve => { queued = resolve; });
    let f;
    f = fixture(t, holdEof ? "hold-after-eof" : "normal", { start: false, recordOperationalEvidence: event => {
      f.journal.push(event);
      if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event));
      if (event.event === "request-sent" && event.method === "thread/fork") queued();
    } });
    const owner = f.start();
    await f.request();
    const wire = observeWire(owner);
    const eofObserved = new Promise(resolve => {
      let output = "";
      owner.child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes('"fixture/eof-observed"')) resolve(true);
      });
      owner.child.once("close", () => resolve(false));
    });
    const original = owner.child.stdin.write;
    let release;
    // The preceding read is physically sent and answered while its write
    // callback remains pending: a deterministic backpressure queue boundary.
    owner.child.stdin.write = function (chunk, callback) {
      const frame = JSON.parse(chunk.toString());
      return original.call(this, chunk, frame.method === "thread/read" ? error => {
        release = cause => callback(cause || error);
      } : callback);
    };
    await f.request();
    assert.equal(typeof release, "function");
    const expires = Date.now() + 100;
    const pending = f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }, { deadlineAt: expires });
    const rejected = assert.rejects(pending, { code });
    // This journal event is in the same stack that enqueues writeInput, so
    // resuming the promise observes the queued request without a timed sleep.
    await enqueued;
    assert.equal(f.journal.some(event => event.event === "request-sent" && event.method === "thread/fork"), true);
    const restoreClock = controlCleanupClock(t, owner);
    try {
      if (action === "deadline") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, expires - Date.now() + 120));
      if (action === "abort") f.controller.abort();
      release(action === "write-failure" ? Object.assign(new Error(code), { code }) : null);
      await rejected;
      const closing = f.transport.close();
      if (holdEof) {
        // Provider has received EOF but intentionally stays alive. This is
        // independent of a delayed/aborted mutation and must never mean success.
        const unclean = assert.rejects(closing, { code: "CODEX_RPC_UNCLEAN_EXIT" });
        assert.equal(await eofObserved, true, "actual fixture received EOF before deliberate escalation");
        assert.equal(f.journal.some(event => event.event === "process-closed"), false);
        const terminate = t.mock.method(owner, "terminate");
        try {
          const phaseMs = Math.floor(f.config.terminationGraceMs / 3);
          t.mock.timers.tick(phaseMs - 1);
          // Drain promise continuations without advancing the controlled clock.
          // An early/unawaited stop must fail even if native close arrives later.
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(terminate.mock.callCount(), 0, "No owned stop before the configured EOF phase elapses");
          assert.equal(f.journal.some(event => event.event === "process-closed"), false);
          t.mock.timers.tick(1); await unclean;
          assert.equal(terminate.mock.calls[0]?.arguments[0], false, "The configured phase first requests an owned soft stop");
        } finally { terminate.mock.restore(); }
      } else await closing;
      assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 0);
      assert.equal(wire.branched(), false);
      const failed = f.journal.find(event => event.event === "request-failed" && event.method === "thread/fork");
      assert.equal(failed.state, "failed"); assert.equal(failed.writeAttempted, false);
      const closed = f.journal.find(event => event.event === "process-closed");
      assert.equal(closed.forced, holdEof, "graceful drain and deadline escalation have distinct strict oracles");
      assert.equal(closed.exactExitObserved, true); assert.equal(closed.supervision.treeCleanupVerified, true);
      assert.equal(closed.cleanupTiming.eofRejected, false);
      assert.ok(closed.cleanupTiming.eofFlushedAtMs >= closed.cleanupTiming.startedAtMs);
      assert.equal(closed.cleanupTiming.softStopAtMs !== null, holdEof);
      assert.ok(closed.cleanupTiming.processCloseAtMs >= closed.cleanupTiming.startedAtMs);
    } finally { restoreClock(); }
  });
}

for (const action of ["end-input", "abort", "deadline", "async-guard"]) {
  test(`interactive write guard ${action} cannot reenter into a physical write`, async t => {
    const f = fixture(t); await f.request();
    const wire = observeWire(f.handle);
    const controller = new AbortController();
    const expires = Date.now() + 100;
    const delivery = f.handle.writeInput(Buffer.from('{"id":"guard-fork","method":"thread/fork","params":{"threadId":"source","lastTurnId":"cutoff"}}\n'), {
      deadlineAt: expires, signal: controller.signal, beforeWrite: () => {
        if (action === "end-input") f.handle.endInput().catch(() => {});
        if (action === "abort") controller.abort();
        if (action === "deadline") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, expires - Date.now() + 120));
        if (action === "async-guard") return Promise.reject(new Error("no async guards"));
      }
    });
    assert.equal(delivery.writeAttempted, false);
    const descriptor = Object.getOwnPropertyDescriptor(delivery, "writeAttempted");
    assert.equal(descriptor.configurable, false); assert.equal(descriptor.set, undefined);
    const code = { "end-input": "PROCESS_SUPERVISOR_INPUT_CLOSED", abort: "PROCESS_SUPERVISOR_INPUT_CANCELLED",
      deadline: "PROCESS_SUPERVISOR_INPUT_DEADLINE", "async-guard": "PROCESS_SUPERVISOR_SYNCHRONOUS_INPUT_GUARD_REQUIRED" }[action];
    await assert.rejects(delivery, { code });
    assert.equal(delivery.writeAttempted, false);
    const restoreClock = controlCleanupClock(t);
    try { await f.transport.close(); }
    finally { restoreClock(); }
    assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 0); assert.equal(wire.branched(), false);
    assert.equal(f.journal.find(event => event.event === "process-closed").forced, false);
  });
}

test("fork write entry followed by cancellation remains uncertain and is never replayed", async t => {
  const f = fixture(t); await f.request();
  const wire = observeWire(f.handle);
  const original = f.handle.child.stdin.write;
  f.handle.child.stdin.write = function (chunk, callback) {
    const result = original.call(this, chunk, callback);
    if (JSON.parse(chunk.toString()).method === "thread/fork") f.controller.abort();
    return result;
  };
  await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }), { code: "CODEX_RPC_CANCELLED" });
  await f.transport.close().catch(() => {});
  assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 1);
  const failed = f.journal.find(event => event.event === "request-failed" && event.method === "thread/fork");
  assert.equal(failed.state, "uncertain"); assert.equal(failed.writeAttempted, true);
  await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }));
  assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 1);
});

for (const [action, code] of [["deadline", "CODEX_RPC_DEADLINE"], ["abort", "CODEX_RPC_CANCELLED"], ["close", "CODEX_RPC_TRANSPORT_CLOSED"]]) {
  test(`supervisor final ${action} guard preserves RPC terminal classification`, async t => {
    const f = fixture(t); await f.request();
    const wire = observeWire(f.handle);
    const input = f.handle.writeInput;
    const controller = new AbortController();
    const expires = Date.now() + 100;
    f.handle.writeInput = (bytes, options) => input(bytes, { ...options, beforeWrite: () => {
      options.beforeWrite();
      // Deliberately widen the tiny post-transport/pre-supervisor check gap.
      if (action === "deadline") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, expires - Date.now() + 120));
      if (action === "abort") controller.abort();
      if (action === "close") f.handle.endInput().catch(() => {});
    } });
    // The low-level signal is deliberately distinct from the request's signal
    // so this oracle exercises the supervisor result, not a transport listener.
    const guardedInput = f.handle.writeInput;
    f.handle.writeInput = (bytes, options) => guardedInput(bytes, { ...options, signal: controller.signal });
    await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }, { deadlineAt: expires }), { code });
    await f.transport.close().catch(() => {});
    assert.equal(f.transport.inspect().failureCode, code);
    assert.equal(wire.writes.filter(frame => frame.method === "thread/fork").length, 0); assert.equal(wire.branched(), false);
    const failed = f.journal.find(event => event.event === "request-failed" && event.method === "thread/fork");
    assert.equal(failed.writeAttempted, false); assert.equal(failed.state, "failed");
  });
}

test("unguarded queued writes retain drain-before-EOF compatibility", async t => {
  const f = fixture(t); await f.request();
  const wire = observeWire(f.handle);
  // Verify native queue ordering, not OS delivery of close within the first
  // 66ms cleanup phase. The existing clock watchdog still bounds stuck fixtures.
  const restoreClock = controlCleanupClock(t);
  try {
    // Unknown response IDs are harmless: closing stops response dispatch,
    // while the real native input queue must still drain before EOF.
    const first = f.handle.writeInput(Buffer.from('{"id":"drain-1","method":"account/read","params":{"refreshToken":false}}\n'));
    const second = f.handle.writeInput(Buffer.from('{"id":"drain-2","method":"account/read","params":{"refreshToken":false}}\n'));
    const closing = f.transport.close();
    await Promise.all([first, second, closing]);
    assert.equal(first.writeAttempted, true); assert.equal(second.writeAttempted, true);
    assert.deepEqual(wire.writes.map(frame => frame.id), ["drain-1", "drain-2"]);
    const closed = f.journal.find(event => event.event === "process-closed");
    assert.equal(closed.forced, false); assert.equal(closed.exactExitObserved, true);
    assert.equal(closed.exitCode, 0); assert.equal(closed.supervision.treeCleanupVerified, true);
    assert.ok(Number.isFinite(closed.cleanupTiming.eofFlushedAtMs));
    assert.equal(closed.cleanupTiming.eofRejected, false);
  } finally { restoreClock(); }
});

test("journal-cancelled turn intent is not a model write attempt", async t => {
  let f;
  f = fixture(t, "normal", { start: false, recordOperationalEvidence: event => {
    f.journal.push(event);
    if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event));
    if (event.event === "request-sent" && event.method === "turn/start") f.controller.abort();
  } });
  const owner = f.start();
  await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" });
  const wire = observeWire(owner);
  await assert.rejects(f.request("turn/start", { threadId: "child", input: [] }), { code: "CODEX_RPC_CANCELLED" });
  await f.transport.close();
  assert.equal(wire.writes.filter(frame => frame.method === "turn/start").length, 0);
  assert.equal(f.transport.inspect().modelCallAttempted, false);
  assert.equal(f.journal.find(event => event.event === "process-closed").modelCallAttempted, false);
});

test("concrete subprocess initializes once and preserves partial UTF-8 frames", async t => {
  const f = fixture(t, "split-utf8");
  assert.equal((await f.request()).thread.model, "합성🙂");
  assert.equal((await f.request()).thread.id, "source");
  assert.equal(f.journal.filter(event => event.event === "request-sent" && event.method === "initialize").length, 1);
  assert.equal(f.transport.ownedTransport, null);
  assert.equal((await f.transport.close()).actualProviderInvoked, false);
});

test("fixed actual constructor cannot expose a fixture start or accept another executable", () => {
  assert.throws(() => createCodexAppServerTransport({ executablePath: process.execPath }), { code: "CODEX_RPC_INVALID_CONFIGURATION" });
  assert.throws(() => createCodexAppServerProtocolFixtureTransport({ executablePath: process.execPath }), { code: "CODEX_RPC_FIXTURE_TARGET_FIXED" });
});

test("scope prevents source mutations, arbitrary methods and token refresh before send", async t => {
  const f = fixture(t);
  for (const [method, params, code] of [["thread/goal/clear", { threadId: "source" }, "CODEX_RPC_SOURCE_TARGET_FORBIDDEN"],
    ["turn/start", { threadId: "source" }, "CODEX_RPC_SOURCE_TARGET_FORBIDDEN"], ["thread/fork", { threadId: "other" }, "CODEX_RPC_SOURCE_TARGET_FORBIDDEN"],
    ["account/login/start", {}, "CODEX_RPC_METHOD_UNSUPPORTED"], ["account/read", {}, "CODEX_RPC_ACCOUNT_REFRESH_FORBIDDEN"]]) {
    await assert.rejects(f.request(method, params), { code });
  }
  assert.equal(f.journal.some(event => event.event === "request-sent"), false);
  assert.equal((await f.request("account/read", { refreshToken: false })).account, null);
});

test("server/client ID collision denies the action without consuming the client response", async t => {
  const f = fixture(t, "approval");
  const result = await f.request();
  assert.deepEqual(JSON.parse(result.thread.preview), { id: "request-0", result: { decision: "cancel" } });
  assert.equal(f.journal.filter(event => event.event === "server-action-denied").length, 1);
});

for (const [index, expected] of [[0, { decision: "cancel" }], [1, { permissions: {}, scope: "turn" }], [2, { answers: {} }],
  [3, { action: "cancel" }], [4, { contentItems: [], success: false }], [5, null], [6, null], [7, { decision: "abort" }], [8, { decision: "abort" }], [9, null]]) {
  test(`server action ${index} is denied without local tool/account side effects`, async t => {
    const f = fixture(t, `deny-${index}`); const result = await f.request();
    const denied = JSON.parse(result.thread.preview);
    if (expected) assert.deepEqual(denied.result, expected); else assert.equal(denied.error.code, -32601);
  });
}

for (const [scenario, code, limits] of [["malformed", "CODEX_RPC_INVALID_FRAME"], ["invalid-utf8", "ERR_ENCODING_INVALID_ENCODED_DATA"],
  ["partial", "CODEX_RPC_PARTIAL_FRAME"], ["overlong", "CODEX_RPC_FRAME_LIMIT", { maxFrameBytes: 2048 }],
  ["stderr-limit", "CODEX_RPC_STDERR_LIMIT", { maxStderrBytes: 2048 }], ["unknown-response", "CODEX_RPC_UNCORRELATED_RESPONSE"],
  ["duplicate-server", "CODEX_RPC_DUPLICATE_SERVER_REQUEST"], ["init-error", "CODEX_RPC_PROVIDER_ERROR"]]) {
  test(`invalid transport ${scenario} fails closed and cleans the exact tree`, async t => {
    // The rejected request starts close before the test can call it. Control
    // that same cleanup clock from the start, not only in t.after: otherwise
    // the 200ms safety budget becomes an unrelated OS scheduling assertion.
    // Exact native close, cleanup proof and PID absence are still required.
    const restoreClock = controlCleanupClock(t);
    try {
      const f = fixture(t, scenario, limits ? { limits } : {});
      await assert.rejects(f.request(), { code });
      assert.equal(f.transport.inspect().failureCode, code);
      if (scenario === "init-error") assert.equal(f.transport.inspect().initialized, false);
      await f.transport.close();
      assert.equal(f.transport.inspect().closed, true);
      const closed = f.journal.find(event => event.event === "process-closed");
      assert.equal(closed.exactExitObserved, true);
      assert.equal(closed.supervision.treeCleanupVerified, true);
    } finally { restoreClock(); }
  });
}

test("duplicate response cannot be reused as a later request result", async t => {
  const f = fixture(t, "duplicate"); await f.request();
  await assert.rejects(f.request(), { code: "CODEX_RPC_DUPLICATE_RESPONSE" });
  assert.equal(f.transport.inspect().failureCode, "CODEX_RPC_DUPLICATE_RESPONSE");
});

test("only exact child notifications reach the bounded worker", async t => {
  const f = fixture(t, "notifications"); await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" });
  const notification = await f.transport.nextNotification({ childThreadId: "child", deadlineAt: f.deadlineAt });
  assert.equal(notification.params.threadId, "child");
  await assert.rejects(f.transport.nextNotification({ childThreadId: "source" }), { code: "CODEX_RPC_SOURCE_TARGET_FORBIDDEN" });
});

test("notification queue and total output are bounded", async t => {
  const f = fixture(t, "notification-limit", { limits: { maxNotifications: 4 } });
  await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" });
  await assert.rejects(f.transport.nextNotification({ childThreadId: "child", deadlineAt: f.deadlineAt }), { code: "CODEX_RPC_NOTIFICATION_LIMIT" });
  assert.equal(f.transport.inspect().failureCode, "CODEX_RPC_NOTIFICATION_LIMIT");
});

for (const scenario of ["lost-fork", "late-fork"]) {
  test(`uncertain ${scenario} mutation is not resent under same or new ID`, async t => {
    const f = fixture(t, scenario);
    await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }, { deadlineAt: Date.now() + 350 }));
    const count = f.journal.filter(event => event.event === "request-sent" && event.method === "thread/fork").length;
    assert.equal(count, 1);
    assert.equal(f.journal.find(event => event.event === "request-failed" && event.method === "thread/fork")?.state, "uncertain");
    await assert.rejects(f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" }));
    assert.equal(f.journal.filter(event => event.event === "request-sent" && event.method === "thread/fork").length, 1);
  });
}

test("same mutation with another ID is rejected even after an acknowledged fork", async t => {
  const f = fixture(t); await f.request("thread/fork", { threadId: "source", lastTurnId: "cutoff" });
  await assert.rejects(f.request("thread/fork", { lastTurnId: "cutoff", threadId: "source" }), { code: "CODEX_RPC_MUTATION_REPLAYED" });
  assert.equal((await f.request("thread/goal/clear", { threadId: "child" })).cleared, true);
});

test("cancellation quiesces a pending request before close resolves", async t => {
  const f = fixture(t, "hang");
  const pending = f.request(); const timer = realTimeout(() => f.controller.abort(), 100);
  const restoreClock = controlCleanupClock(t);
  try {
    await assert.rejects(pending, { code: "CODEX_RPC_CANCELLED" });
    await f.transport.close(); assert.equal(f.transport.inspect().closed, true);
  } finally { realClearTimeout(timer); restoreClock(); }
});

test("EOF-resistant subprocess is owned, forcibly cleaned and never reported clean", async t => {
  const f = fixture(t, "ignore-eof");
  const pending = f.request("thread/read", { threadId: "source" }, { deadlineAt: Date.now() + 250 });
  await assert.rejects(pending, { code: "CODEX_RPC_DEADLINE" });
  await assert.rejects(f.transport.close(), { code: "CODEX_RPC_UNCLEAN_EXIT" });
  const closed = f.journal.find(event => event.event === "process-closed");
  assert.equal(closed.forced, true);
  assert.equal(closed.cleanupTiming.graceMs, 200);
  assert.equal(closed.cleanupTiming.eofRejected, false);
  assert.ok(closed.cleanupTiming.eofFlushedAtMs >= closed.cleanupTiming.startedAtMs);
  // The 65+1 controlled-clock boundary above proves the unchanged 66ms phase.
  // Real Node timers do not guarantee an exact performance.now delta:
  // https://github.com/nodejs/node/blob/v24.18.0/doc/api/timers.md#settimeoutcallback-delay-args
  assert.ok(closed.cleanupTiming.softStopAtMs >= closed.cleanupTiming.eofFlushedAtMs);
  assert.ok(closed.cleanupTiming.processCloseAtMs >= closed.cleanupTiming.softStopAtMs);
  assert.equal(closed.exactExitObserved, true);
  assert.equal(closed.supervision.ownershipEstablished, true);
  assert.equal(closed.supervision.treeCleanupVerified, true);
});

test("closing a never-started connection prevents late spawning", async t => {
  const f = fixture(t, "normal", { start: false });
  assert.equal((await f.transport.close()).started, false);
  assert.throws(() => f.start(), { code: "CODEX_RPC_TRANSPORT_REPLAYED" });
});

test("journal-time cancellation is rechecked before native spawn", async t => {
  const controller = new AbortController();
  const f = fixture(t, "normal", { start: false, recordOperationalEvidence: event => {
    if (event.event === "process-planned") controller.abort();
  } });
  assert.throws(() => f.start(controller.signal), { code: "CODEX_RPC_BINDING_MISMATCH" });
  assert.equal(f.transport.inspect().started, false);
});

test("total output is bounded independently of frame size", async t => {
  const f = fixture(t, "normal", { limits: { maxOutputBytes: 100 } });
  await assert.rejects(f.request(), { code: "CODEX_RPC_OUTPUT_LIMIT" });
});

test("read-only observation uses the same engine without worker authority or mutation access", async t => {
  const f = fixture(t, "normal", { start: false });
  const journal = [];
  const probe = createCodexAppServerProtocolFixtureTransport({ ...f.config, controlFile: path.join(f.config.executionRoot, "probe.jsonl"),
    readOnlyProbe: true, recordOperationalEvidence: event => { journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); } });
  const handle = probe.startReadOnly({ deadlineAt: f.deadlineAt, signal: f.controller.signal });
  f.trackOwned(probe, handle, journal);
  let priorError;
  try {
    assert.equal(Object.isFrozen(handle), true);
    assert.deepEqual(Object.keys(handle).sort(), ["parentPid", "pid", "started"]);
    assert.equal(handle.child, undefined); assert.equal(handle.writeInput, undefined);
    for (const method of ["thread/read", "thread/fork", "thread/goal/get", "thread/goal/clear", "turn/start"]) {
      await assert.rejects(probe.request({ requestId: method, method, params: {}, deadlineAt: f.deadlineAt }), { code: "CODEX_RPC_READ_ONLY_PROBE" });
    }
    const observed = await probe.request({ requestId: "account", method: "account/read", params: { refreshToken: false }, deadlineAt: f.deadlineAt });
    assert.equal(observed.account, null); assert.equal(probe.ownedTransport, null);
    assert.equal(probe.inspect().modelCallAttempted, false);
    assert.equal(journal.some(event => Object.hasOwn(event, "authorizationHash")), false);
    assert.equal(journal.every(event => event.diagnosticId.startsWith("codex-readonly-")), true);
  } catch (cause) { priorError = cause; }
  finally {
    const restoreClock = controlCleanupClock(t);
    try {
      await finishCodexAppServerFixture({ transport: probe, owner: handle, journal, priorError,
        verify: () => {
          assert.equal(probe.inspect().closed, true);
          assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, true);
        } });
    } finally { restoreClock(); }
  }
});

test("read-only request snapshots survive caller mutation during initialize", async t => {
  const f = fixture(t, "normal", { start: false });
  const journal = [];
  const probe = createCodexAppServerProtocolFixtureTransport({ ...f.config, controlFile: path.join(f.config.executionRoot, "immutable.jsonl"),
    readOnlyProbe: true, recordOperationalEvidence: event => { journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); } });
  const identity = probe.startReadOnly({ deadlineAt: f.deadlineAt });
  f.trackOwned(probe, identity, journal);
  let priorError;
  try {
    const params = { refreshToken: false };
    const call = { requestId: "readonly-snapshot", method: "account/read", params, deadlineAt: f.deadlineAt };
    const pending = probe.request(call);
    params.refreshToken = true;
    call.method = "turn/start";
    call.params = { threadId: "source", input: [{ type: "text", text: "never sent", text_elements: [] }] };
    call.requestId = "changed-request";
    assert.equal((await pending).account, null);
    assert.deepEqual(journal.filter(event => event.event === "request-sent").map(event => event.method), ["initialize", "account/read"]);
    const sent = journal.find(event => event.method === "account/read" && event.event === "request-sent");
    assert.deepEqual(sent.params, { refreshToken: false }); assert.equal(sent.requestId, "readonly-snapshot");
  } catch (cause) { priorError = cause; }
  finally {
    const restoreClock = controlCleanupClock(t);
    try {
      await finishCodexAppServerFixture({ transport: probe, owner: identity, journal, priorError,
        verify: () => {
          assert.equal(probe.inspect().closed, true);
          assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, true);
        } });
    } finally { restoreClock(); }
  }
});

test("request snapshots reject accessors, proxies and non-JSON data without executing getters", async t => {
  const f = fixture(t);
  let getterCalls = 0;
  const getter = { get refreshToken() { getterCalls++; return false; } };
  const cyclic = {}; cyclic.self = cyclic;
  for (const params of [getter, new Proxy({}, { get() { getterCalls++; return false; } }), { value: Infinity },
    { value: undefined }, new Date(), { value: BigInt(1) }, { value: [,,] }, cyclic, { value() {} }]) {
    await assert.rejects(f.request("account/read", params), { code: "CODEX_RPC_INVALID_REQUEST_DATA" });
  }
  await assert.rejects(f.transport.request({ requestId: "getter", get method() { getterCalls++; return "account/read"; }, params: { refreshToken: false } }), { code: "CODEX_RPC_INVALID_REQUEST_DATA" });
  assert.equal(getterCalls, 0);
  assert.equal(f.journal.some(event => event.event === "request-sent"), false);
});

test("late cancellation after clean closure cannot rewrite the observed outcome", async t => {
  const f = fixture(t);
  await f.request();
  const closed = await f.transport.close();
  f.controller.abort();
  assert.equal(f.transport.inspect().failureCode, null);
  assert.equal(await f.transport.close(), closed);
  assert.equal(f.journal.find(event => event.event === "process-closed").forced, false);
});

test("failed cleanup assertion preserves its error and still removes the exact stopped fixture", async t => {
  const f = fixture(t); await f.request();
  const original = new Error("injected cleanup assertion failure");
  const restoreClock = controlCleanupClock(t);
  try {
    await assert.rejects(finishCodexAppServerFixture({ transport: f.transport, owner: f.handle, journal: f.journal,
      dir: f.config.executionRoot, verify: () => { throw original; } }), cause => cause === original);
  } finally { restoreClock(); }
  assert.equal(fs.existsSync(f.config.executionRoot), false);
  assert.equal(f.transport.inspect().closed, true);
  const closed = f.journal.find(event => event.event === "process-closed");
  assert.equal(closed.supervision.treeCleanupVerified, true);
  for (const pid of [f.handle.child.pid, closed.providerPid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("configuration-only fixture retains evidence for its borrowed live owner", async t => {
  const hooks = [];
  const f = fixture({ after: hook => hooks.push(hook), mock: t.mock, diagnostic: value => t.diagnostic(value) }, "normal", { start: false });
  t.after(() => fs.rmSync(f.config.executionRoot, { recursive: true, force: true }));
  let closeCalls = 0;
  const transport = { close: async () => { closeCalls++; }, inspect: () => ({ closed: true, started: true }) };
  // A known live PID is an observation-only negative control, never a signal
  // target. The directory cannot be removed by the unused config transport.
  f.trackOwned(transport, { state: { providerPid: process.pid } }, [], { verify: () => {} });
  await assert.rejects(hooks[0](), /owned fixture PID .* must be absent/);
  assert.equal(closeCalls, 1);
  assert.equal(fs.existsSync(f.config.executionRoot), true);
});

test("early teardown failure still stops the exact live owner and preserves the original assertion", async t => {
  const f = fixture(t, "normal", { start: false });
  const journal = [];
  const transport = createCodexAppServerProtocolFixtureTransport({ ...f.config, recordOperationalEvidence: event => {
    journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); } });
  const owner = transport.startFixture({ ownershipBinding: f.ownershipBinding, deadlineAt: f.deadlineAt });
  f.trackOwned(transport, owner, journal, { allowUncleanClose: true, verify: () => assert.equal(transport.inspect().closed, true) });
  await transport.request({ requestId: "read", method: "thread/read", params: { threadId: "source", includeTurns: true } });
  const original = new Error("injected early teardown failure");
  const brokenClose = { ...transport, close: async () => { throw original; } };
  await assert.rejects(finishCodexAppServerFixture({ transport: brokenClose, owner, journal,
    dir: f.config.executionRoot, verify: () => { throw original; } }), cause => cause === original);
  assert.equal(fs.existsSync(f.config.executionRoot), false);
  assert.equal(transport.inspect().closed, true);
  // Protective teardown cannot retroactively supply missing transport proof.
  if (process.platform === "win32") assert.equal(journal.find(event => event.event === "process-closed").supervision.treeCleanupVerified, false);
  for (const pid of [owner.child.pid, owner.state.providerPid]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("missing native cleanup evidence remains uncertain and cannot settle cancellation", async t => {
  const f = fixture(t, "normal", { start: false });
  const journal = [];
  const transport = createCodexAppServerProtocolFixtureTransport({ ...f.config,
    controlFile: path.join(f.config.executionRoot, "invalid-control.jsonl"),
    recordOperationalEvidence: event => { journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); } });
  const owner = transport.startFixture({ ownershipBinding: f.ownershipBinding, deadlineAt: f.deadlineAt });
  f.trackOwned(transport, owner, journal, { allowUncleanClose: true, verify: () =>
    assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, false) });
  let priorError;
  try {
    await transport.request({ requestId: "read", method: "thread/read", params: { threadId: "source", includeTurns: true } });
    // Leave enough invalid trailing bytes to survive subsequent native writes.
    // Replacing an open control file is not supported by Windows sharing rules.
    fs.appendFileSync(path.join(f.config.executionRoot, "invalid-control.jsonl"), "{invalid-control}\n".repeat(128));
    await assert.rejects(transport.close(), { code: "CODEX_RPC_CLEANUP_UNCERTAIN" });
    const closed = journal.find(event => event.event === "process-closed");
    assert.equal(closed.supervision.controlInvalid, true);
    assert.equal(closed.supervision.treeCleanupVerified, false);
    let committed = false;
    await assert.rejects(transport.cleanup({ reason: "CODEX_NATIVE_FORK_CANCELLED", commit: () => { committed = true; } }),
      { code: "CODEX_RPC_CLEANUP_UNCERTAIN" });
    assert.equal(committed, false);
  } catch (cause) { priorError = cause; }
  finally {
    await finishCodexAppServerFixture({ transport, owner, journal, priorError, allowUncleanClose: true,
      verify: () => assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, false) });
  }
});

test("hard escalation retains unclean classification and verifies the exact owned tree", async t => {
  const f = fixture(t, "hold-after-eof-ignore-term", { start: false });
  const journal = [];
  const transport = createCodexAppServerProtocolFixtureTransport({ ...f.config, recordOperationalEvidence: event => {
    journal.push(event); if (event.event.startsWith("process-")) t.diagnostic(JSON.stringify(event)); } });
  const owner = transport.startFixture({ ownershipBinding: f.ownershipBinding, deadlineAt: f.deadlineAt });
  f.trackOwned(transport, owner, journal, { allowUncleanClose: true, verify: () =>
    assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, process.platform === "win32") });
  await transport.request({ requestId: "read", method: "thread/read", params: { threadId: "source", includeTurns: true } });
  const kill = owner.child.kill;
  // Deterministically resist soft termination at the test-owned signal boundary.
  // SIGKILL and the real native kernel/tree cleanup remain unchanged.
  owner.child.kill = function (signal) { return signal === "SIGTERM" ? true : kill.call(this, signal); };
  let priorError;
  try {
    await assert.rejects(transport.close(), { code: process.platform === "win32" ? "CODEX_RPC_UNCLEAN_EXIT" : "CODEX_RPC_CLEANUP_UNCERTAIN" });
    const closed = journal.find(event => event.event === "process-closed");
    assert.equal(closed.forced, true);
    assert.notEqual(closed.cleanupTiming.softStopAtMs, null);
    assert.notEqual(closed.cleanupTiming.hardStopAtMs, null);
    assert.equal(closed.exactExitObserved, true);
    // Windows has the kernel Job close boundary; POSIX cannot synthesize the
    // journal of a SIGKILLed owner even if the exact group was actually killed.
    assert.equal(closed.supervision.treeCleanupVerified, process.platform === "win32");
  } catch (cause) { priorError = cause; }
  finally {
    await finishCodexAppServerFixture({ transport, owner, journal, priorError, allowUncleanClose: true, verify: () =>
      assert.equal(journal.find(event => event.event === "process-closed")?.supervision.treeCleanupVerified, process.platform === "win32") });
  }
});

test("unexpected nonzero closure cannot be reclassified by a caller cancellation reason", async t => {
  const f = fixture(t, "nonzero-after-read");
  await f.request();
  await assert.rejects(f.transport.close(), { code: "CODEX_RPC_UNCLEAN_EXIT" });
  let committed = false;
  await assert.rejects(f.transport.cleanup({ reason: "CODEX_NATIVE_FORK_CANCELLED", commit: async () => { committed = true; } }), { code: "CODEX_RPC_UNCLEAN_EXIT" });
  assert.equal(committed, false);
  const closed = f.journal.find(event => event.event === "process-closed");
  assert.equal(closed.exitCode, 7); assert.equal(closed.supervision.treeCleanupVerified, true);
});

for (const [kind, expectedCode, reason] of [["cancel", "CODEX_RPC_CANCELLED", "CODEX_NATIVE_FORK_CANCELLED"],
  ["deadline", "CODEX_RPC_DEADLINE", "CODEX_NATIVE_FORK_DEADLINE"]]) {
  test(`verified forced ${kind} cleanup settles the stop without granting success`, async t => {
    const f = fixture(t, "ignore-eof");
    const check = { ownershipBinding: f.ownershipBinding, executablePathDigest: hash(path.resolve(process.execPath)),
      executionRootDigest: hash(f.config.executionRoot), supervisorManifestDigest: f.config.supervisorSelection.manifest.manifestHash };
    f.handle.state.terminationRequested = true;
    assert.equal(verifyRuntimeProcessSupervisorHandle(f.handle, check).terminationRequested, false, "caller state is not termination proof");
    const pending = f.request("thread/read", { threadId: "source" }, kind === "deadline" ? { deadlineAt: Date.now() + 300 } : {});
    const timer = kind === "cancel" ? setTimeout(() => f.controller.abort(), 180) : null;
    await assert.rejects(pending, { code: expectedCode }); clearTimeout(timer);
    await assert.rejects(f.transport.close(), { code: "CODEX_RPC_UNCLEAN_EXIT" });
    assert.equal(verifyRuntimeProcessSupervisorHandle(f.handle, check).terminationRequested, true);
    let committed = 0;
    await assert.rejects(f.transport.cleanup({ reason: "completed", commit: async () => { committed++; } }), { code: "CODEX_RPC_UNCLEAN_EXIT" });
    assert.equal(committed, 0);
    await f.transport.cleanup({ reason, commit: async () => { committed++; } });
    assert.equal(committed, 1);
    assert.equal(f.transport.inspect().closed, true);
    assert.equal(f.journal.find(event => event.event === "process-closed").supervision.treeCleanupVerified, true);
  });
}
