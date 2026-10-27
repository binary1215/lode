import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { observeClaudeProcess, probeClaudeProcesses, probeNativeProcesses } from "../scripts/lib/native-session-process.mjs";

const envToken = "a".repeat(64), nativeSessionId = "claude-synthetic-only";
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-native-process-"))), sessions = path.join(base, "sessions"); fs.mkdirSync(sessions);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, sessions, environment: { CLAUDE_CONFIG_DIR: base } };
}
const row = (pid, ppid, birth = "100", state = "present") => ({ pid, ppid, birth, state });
const witness = (pid, birth = "100") => ({ pid, ppid: 1, birth, environment: envToken, platform: "linux" });

test("exact actual ancestry + registry + OS birth, not first matching registry or immediate shell guess", async t => {
  const f = fixture(t), parent = 12345;
  fs.writeFileSync(path.join(f.sessions, `${parent}.json`), JSON.stringify({ pid: parent, sessionId: nativeSessionId }));
  fs.writeFileSync(path.join(f.sessions, "99999.json"), JSON.stringify({ sessionId: nativeSessionId })); // never enumerate
  const original = fs.readdirSync;
  fs.readdirSync = file => { if (String(file).startsWith(f.base)) throw new Error("Registry enumeration forbidden"); return original(file); };
  try {
    const got = await observeClaudeProcess({ nativeSessionId, environment: f.environment, platform: "linux",
      probe: async ({ startPid }) => { assert.equal(startPid, process.pid); return { environment: envToken, rows: [row(process.pid, parent, "200"), row(parent, 1)] }; } });
    assert.deepEqual(got, witness(parent));
  } finally { fs.readdirSync = original; }
});

test("PID-field mismatch, parent reuse/birth reversal, missing registry and unsupported platform are unknown", async t => {
  const f = fixture(t), parent = 12345;
  const probe = async () => ({ environment: envToken, rows: [row(process.pid, parent, "200"), row(parent, 1)] });
  assert.equal(await observeClaudeProcess({ nativeSessionId, environment: f.environment, platform: "linux", probe }), null);
  fs.writeFileSync(path.join(f.sessions, `${parent}.json`), JSON.stringify({ pid: 999, sessionId: nativeSessionId }));
  assert.equal(await observeClaudeProcess({ nativeSessionId, environment: f.environment, platform: "linux", probe }), null);
  fs.writeFileSync(path.join(f.sessions, `${parent}.json`), JSON.stringify({ pid: parent, sessionId: nativeSessionId }));
  assert.equal(await observeClaudeProcess({ nativeSessionId, environment: f.environment, platform: "linux",
    probe: async () => ({ environment: envToken, rows: [row(process.pid, parent, "50"), row(parent, 1)] }) }), null);
  assert.equal(await probeNativeProcesses({ pids: [process.pid], platform: "darwin" }), null);
});

test("reader tri-state: live, registry missing/denied unknown, exact old PID absent/reused ends only that instance", async t => {
  const f = fixture(t), pid = 12345;
  const check = (rows, token = envToken) => probeClaudeProcesses({ instances: [witness(pid)], nativeSessionId,
    environment: f.environment, platform: "linux", probe: async () => ({ environment: token, rows }) });
  assert.equal((await check([row(pid, 1)]))[0].state, "unknown");
  fs.writeFileSync(path.join(f.sessions, `${pid}.json`), JSON.stringify({ sessionId: nativeSessionId }));
  assert.equal((await check([row(pid, 1)]))[0].state, "live-at-check");
  assert.equal((await check([row(pid, 1)], "b".repeat(64)))[0].state, "unknown");
  fs.unlinkSync(path.join(f.sessions, `${pid}.json`));
  assert.equal((await check([row(pid, 1, "100", "unknown")]))[0].state, "unknown");
  assert.equal((await check([row(pid, 1, "100", "gone")]))[0].state, "ended-at-check");
  assert.equal((await check([row(pid, 1, "999")]))[0].state, "ended-at-check");
});

test("same native ID distinct instances, one live/one gone; old birth never closes new process", async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.sessions, "12345.json"), JSON.stringify({ sessionId: nativeSessionId }));
  const instances = [witness(12345), witness(54321)], checks = await probeClaudeProcesses({ instances, nativeSessionId, environment: f.environment, platform: "linux",
    probe: async ({ pids }) => { assert.deepEqual(pids, [12345, 54321]); return { environment: envToken, rows: [row(12345, 1), row(54321, 1, "100", "gone")] }; } });
  assert.deepEqual(checks.map(x => x.state), ["live-at-check", "ended-at-check"]);
  assert.ok(checks.every(x => x.scope === "observed-hosting-instance-not-agent-activity"));
});

test("incomparable birth formats and invalid PID inputs stay unknown, never guessed ended", async t => {
  const f = fixture(t), old = { pid: 12345, ppid: 1, birth: "2026-10-18T00:00:00.0000000Z", environment: envToken, platform: "win32" };
  for (const current of [{ pid: 12345, state: "gone" }, { pid: 12345, ppid: 1, birth: "windows-filetime-100", state: "present" }]) {
    const result = await probeClaudeProcesses({ instances: [old], nativeSessionId, environment: f.environment, platform: "win32",
      probe: async () => ({ environment: envToken, rows: [current] }) });
    assert.equal(result[0].state, "unknown");
  }
  assert.equal(await probeNativeProcesses({ pids: [0x100000001], platform: "win32" }), null);
});

test("actual local OS probe uses owned synthetic registry only, returns birth; helper closes and leaves no owned port", async t => {
  if (!["win32", "linux"].includes(process.platform)) { t.skip("Exact OS birth adapter unsupported on this platform."); return; }
  const f = fixture(t), records = [], onProcess = record => { records.push(record); t.diagnostic(JSON.stringify(record)); };
  const cwdNames = fs.readdirSync(process.cwd()).sort();
  fs.writeFileSync(path.join(f.sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: nativeSessionId }));
  const inputs = [], originalSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args), end = child.stdin?.end;
    if (end) child.stdin.end = function (chunk, ...rest) {
      if (chunk !== undefined) inputs.push(Buffer.from(chunk));
      return end.call(this, chunk, ...rest);
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
  const start = Date.now(), got = await observeClaudeProcess({ nativeSessionId, environment: f.environment, onProcess });
  t.diagnostic(JSON.stringify({ scope: "synthetic-registry-actual-task-owned-node-not-Claude-Host", durationMs: Date.now() - start }));
  assert.ok(got, "Actual OS probe must provide an exact own birth witness in the claimed local adapter."); assert.equal(got.pid, process.pid);
  const checked = await probeClaudeProcesses({ instances: [got], nativeSessionId, environment: f.environment, onProcess });
  assert.equal(checked[0].state, "live-at-check");
  assert.deepEqual(fs.readdirSync(process.cwd()).sort(), cwdNames, "OS helper must not write into its working directory.");
  for (const started of records.filter(x => x.event === "started")) {
    assert.ok(records.some(x => x.event === "closed" && x.pid === started.pid));
    assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
  }
  if (process.platform === "win32") {
    for (const [index, planned] of records.filter(x => x.event === "planned").entries()) {
      assert.deepEqual(planned.arguments, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"]);
      assert(Number.isSafeInteger(planned.inputBytes) && planned.inputBytes > 0);
      assert.match(planned.inputDigest, /^[a-f0-9]{64}$/u);
      const bytes = inputs[index]; assert.equal(bytes.length, planned.inputBytes + 2);
      const script = bytes.subarray(0, planned.inputBytes);
      assert.equal(crypto.createHash("sha256").update(script).digest("hex"), planned.inputDigest);
      assert.doesNotMatch(script.toString("utf8"), /GetProcessById|GetProcessIds|EnumProcesses|Get-Process\b|Add-Type/iu);
      assert.match(script.toString("utf8"), /OpenExact/); assert.match(script.toString("utf8"), /CloseHandle/);
    }
  }
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});

test("actual owned child birth then normal exit verifies old-instance disappearance, not work completion", async t => {
  if (!["win32", "linux"].includes(process.platform)) { t.skip("Exact OS birth adapter unsupported on this platform."); return; }
  const f = fixture(t), args = ["-e", "process.stdin.resume()"], records = [], onProcess = x => { records.push(x); t.diagnostic(JSON.stringify(x)); };
  t.diagnostic(JSON.stringify({ event: "planned", command: process.execPath, arguments: args, cwd: f.base, parent: process.pid, ports: [], windowsHide: true }));
  const child = spawn(process.execPath, args, { cwd: f.base, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  t.diagnostic(JSON.stringify({ event: "started", pid: child.pid, parent: process.pid, command: process.execPath, arguments: args, cwd: f.base, ports: [] }));
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { t.diagnostic(JSON.stringify({ event: "closed", pid: child.pid, code, signal, ports: [] })); resolve(code); }); });
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 10000);
  try {
    const observed = await probeNativeProcesses({ pids: [child.pid], onProcess });
    assert.ok(observed?.rows[0]?.birth);
    const old = { ...observed.rows[0], environment: observed.environment, platform: process.platform }; delete old.state;
    fs.writeFileSync(path.join(f.sessions, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: nativeSessionId }));
    child.stdin.end(); assert.equal(await done, 0);
    const checked = await probeClaudeProcesses({ instances: [old], nativeSessionId, environment: f.environment, onProcess });
    assert.equal(checked[0].state, "ended-at-check"); assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await done;
  }
});
