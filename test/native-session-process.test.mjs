import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { decodeWindowsProcessQueryWire, decodeWindowsCodexInventoryWire, WINDOWS_PROCESS_QUERY_WIRE } from "../scripts/lib/windows-process-query-wire.mjs";
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
      assert.doesNotMatch(script.toString("utf8"), /GetProcessById|GetProcessIds|EnumProcesses|Get-Process\b|Add-Type|ConvertTo-Json|ConvertFrom-Json|Import-Module/iu);
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
    const ancestry = await probeNativeProcesses({ startPid: child.pid, stopPid: process.pid, onProcess });
    assert.equal(ancestry?.rows[0]?.pid, child.pid);
    assert.equal(ancestry.rows[0].ppid, process.pid, "Exact child handle must identify the actual owned parent");
    assert.equal(ancestry.rows[0].birth, observed.rows[0].birth);
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


test("Windows exact parent query rejects denied, malformed and mismatched native results", { skip: process.platform !== "win32" }, async t => {
  for (const fault of ["status", "length", "unique", "parent"]) await t.test(fault, async sub => {
    const originalSpawn = childProcess.spawn; let injected = false; const records = [];
    childProcess.spawn = (...args) => {
      const child = originalSpawn(...args), end = child.stdin?.end;
      if (end) child.stdin.end = function(chunk, ...rest) {
        let script = String(chunk);
        const target = fault === "status" || fault === "length"
          ? "$taskStatus -ne 0 -or $taskReturned -ne $taskLength"
          : "$taskUnique -ne $taskId -or $taskParent -lt 0";
        const bad = fault === "status" ? "-1 -ne 0 -or $taskReturned -ne $taskLength"
          : fault === "length" ? "$taskStatus -ne 0 -or 0 -ne $taskLength"
          : fault === "unique" ? "0 -ne $taskId -or $taskParent -lt 0"
          : "$taskUnique -ne $taskId -or -1 -lt 0";
        if (script.includes(target)) { script = script.replace(target, bad); injected = true; }
        return end.call(this, script, ...rest);
      }; return child;
    }; syncBuiltinESMExports();
    try {
      const result = await probeNativeProcesses({ startPid: process.pid, stopPid: process.ppid, onProcess: value => records.push(value) });
      assert(injected); assert.equal(result?.rows[0]?.state, "unknown");
      assert.equal(result.rows[0].birth, undefined);
      for (const started of records.filter(value => value.event === "started")) { assert(records.some(value => value.event === "closed" && value.pid === started.pid)); assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" }); }
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
  });
});


test("private query wire preserves typed observations and refuses incomplete or foreign evidence", () => {
  const encode = value => Buffer.from(value).toString("base64"), machine = 'machine\n한글"\\', host = 'host-☃';
  const make = rows => Buffer.from(["LODE-PROCESS-QUERY\t1", "MACHINE\t" + encode(machine), "HOST\t" + encode(host), "COUNT\t" + rows.length, ...rows, "END", ""].join("\n"));
  const own = "ROW\t10\tpresent\t0\t18446744073709551615\t-", route = { pids: [10], maxRows: 16 };
  assert.deepEqual(decodeWindowsProcessQueryWire(make([own]), route), { machine, hostName: host, rows: [{ pid: 10, state: "present", ppid: 0, birth: "windows-filetime-18446744073709551615" }] });
  assert.deepEqual(decodeWindowsProcessQueryWire(make([]), { pids: [], maxRows: 16 }).rows, []);
  const unknown = decodeWindowsProcessQueryWire(make(["ROW\t10\tunknown\t-\t-\t5"]), route).rows[0];
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.birth, undefined);
  assert.equal(decodeWindowsProcessQueryWire(make(["ROW\t10\tgone\t-\t-\t87"]), route).rows[0].state, "gone");
  const raw = make([own]).toString();
  const invalid = [raw.replace("QUERY\t1", "QUERY\t2"), raw.replace("COUNT\t1", "COUNT\t2"), raw.replace("END\n", ""), raw + "extra\n", raw.slice(0, -1), raw.replace("ROW\t10", "ROW\t11"), raw.replace("ROW\t10", "ROW\t010"), raw.replace("present", "succeeded"), raw.replace("\t0\t184", "\t10\t184"), raw.replace("18446744073709551615", "18446744073709551616"), raw.replace("HOST\t" + encode(host), "HOST\tZh=="), raw.replace("HOST\t" + encode(host), "HOST\t/w=="), raw.replace("MACHINE\t" + encode(machine), "MACHINE\t"), raw.replace("LODE-PROCESS-QUERY", "LODE-CODEX-INVENTORY")];
  for (const bad of invalid) assert.throws(() => decodeWindowsProcessQueryWire(Buffer.from(bad), route));
  assert.throws(() => decodeWindowsProcessQueryWire(make([own, own]), { pids: [10, 10], maxRows: 16 }));
  assert.throws(() => decodeWindowsProcessQueryWire(make(["ROW\t10\tgone\t-\t-\t5"]), route));
  assert.throws(() => decodeWindowsProcessQueryWire(make(["ROW\t10\tpresent\t20\t100\t-"]), { startPid: 10, maxRows: 9 }));
  assert.throws(() => decodeWindowsProcessQueryWire(Buffer.alloc(65537), route));
  assert.deepEqual(decodeWindowsProcessQueryWire(make(["ROW\t10\tpresent\t20\t100\t-", "ROW\t20\tpresent\t0\t99\t-"]), { startPid: 10, stopPid: 20, maxRows: 9 }).rows.map(row => row.pid), [10, 20]);
});

test("private name inventory wire cannot become a PID witness or authorize unknown publication", () => {
  const birth = "2026-11-03T01:02:03.1234567Z", encoded = Buffer.from(birth).toString("base64");
  const frame = rows => Buffer.from(["LODE-CODEX-INVENTORY\t1", "COUNT\t" + rows.length, ...rows, "END", ""].join("\r\n"));
  assert.deepEqual(decodeWindowsCodexInventoryWire(frame([])), { status: "observed", rows: [] });
  assert.deepEqual(decodeWindowsCodexInventoryWire(frame(["ROW\t10\t0\t" + encoded])), { status: "observed", rows: [{ pid: 10, parentPid: 0, birth, home: "unresolved" }] });
  for (const rows of [["ROW\t0\t0\t" + encoded], ["ROW\t10\t10\t" + encoded], ["ROW\t10\t0\t" + encoded, "ROW\t10\t0\t" + encoded], ["ROW\t10\t0\t/w=="], ["ROW\t10\t0\t" + Buffer.from("2026-02-31T01:02:03.1234567Z").toString("base64")]]) assert.throws(() => decodeWindowsCodexInventoryWire(frame(rows)));
  assert.throws(() => decodeWindowsProcessQueryWire(frame([]), { pids: [], maxRows: 16 }));
});


test("actual private wire emitter roundtrips Unicode, empty arrays and exact primitive columns", { skip: process.platform !== "win32" }, async t => {
  const machine = 'machine\n한글"\\', host = 'host-☃', birth = "2026-11-03T01:02:03.1234567Z";
  const literal = value => "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(value).toString("base64") + "')))";
  const script = WINDOWS_PROCESS_QUERY_WIRE + "\nWrite-TaskProcessQueryWire " + literal(machine) + " " + literal(host) + " @()\nWrite-TaskProcessQueryWire " + literal(machine) + " " + literal(host) + " @(@{pid=[long]10;ppid=[long]0;state='present';birth='windows-filetime-18446744073709551615'})\nWrite-TaskCodexInventoryWire @(@{pid=[long]10;parentPid=[long]0;birth='" + birth + "'})\n";
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"];
  t.diagnostic(JSON.stringify({ event: "planned-wire-emitter", parent: process.pid, ports: [], windowsHide: true, inputBytes: Buffer.byteLength(script), budgetMs: 1500 }));
  const child = spawn(executable, args, { windowsHide: true, shell: false, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: ["pipe", "pipe", "pipe"] });
  const done = new Promise((resolve, reject) => {
    let out = "", error = "", size = 0; const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
    child.once("error", reject); child.stdin.on("error", reject);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { size += bytes.length; if (size > 65536) child.kill("SIGTERM"); else if (stream === child.stdout) out += bytes.toString("utf8"); else error += bytes.toString("utf8"); });
    child.once("close", (code, signal) => { clearTimeout(timer); child.stdin.destroy(); t.diagnostic(JSON.stringify({ event: "closed-wire-emitter", pid: child.pid, parent: process.pid, code, signal, ports: [] })); if (code !== 0) reject(Error("Owned wire emitter did not complete within its existing budget: " + signal)); else resolve(out); });
  }); child.stdin.end(script + "\n\n");
  const output = (await done).replace(/\r\n/g, "\n"), frames = output.match(/LODE-(?:PROCESS-QUERY|CODEX-INVENTORY)[\s\S]*?END\n/g);
  assert.equal(frames.length, 3);
  assert.deepEqual(decodeWindowsProcessQueryWire(Buffer.from(frames[0]), { pids: [], maxRows: 16 }), { machine, hostName: host, rows: [] });
  assert.equal(decodeWindowsProcessQueryWire(Buffer.from(frames[1]), { pids: [10], maxRows: 16 }).rows[0].birth, "windows-filetime-18446744073709551615");
  assert.deepEqual(decodeWindowsCodexInventoryWire(Buffer.from(frames[2])), { status: "observed", rows: [{ pid: 10, parentPid: 0, birth, home: "unresolved" }] });
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
