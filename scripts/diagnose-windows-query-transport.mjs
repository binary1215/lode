// Temporary bounded CI diagnosis. Synthetic self/parent query only; no home,
// account, history, process command line, policy change or new runtime.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { WINDOWS_EXACT_PROCESS_QUERY } from "./lib/windows-exact-process-query.mjs";
import { probeNativeProcesses } from "./lib/native-session-process.mjs";
import { observeCodexNativeWriters } from "./lib/codex-native-offline.mjs";

if (process.platform !== "win32") throw new Error("Windows-only synthetic transport diagnosis");
const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const script = `$ErrorActionPreference='Stop';[Console]::Error.WriteLine('phase:script-entered');
${WINDOWS_EXACT_PROCESS_QUERY}
$row=Read-TaskExactProcess ${process.pid} $true
[Console]::Error.WriteLine('phase:query-returned');$row|ConvertTo-Json -Compress`;
assert(script.length < 12000);
const common = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
const narrowKeys = ["SystemRoot", "WINDIR", "TEMP", "TMP"];
const bootstrapKeys = [...narrowKeys, "SystemDrive", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramW6432", "PROCESSOR_ARCHITECTURE", "ComSpec"];
const environment = keys => Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
console.log(JSON.stringify({ event: "diagnostic-runtime", node: process.version, arch: process.arch, allowedEnvironmentKeysPresent: bootstrapKeys.filter(key => process.env[key]), scriptBytes: Buffer.byteLength(script), scriptDigest: crypto.createHash("sha256").update(script).digest("hex") }));

async function compare(mode, expanded = false, serialization = "automatic", budgetMs = 1500) {
  const started = performance.now(), deadline = started + budgetMs;
  const body = serialization === "primitive" ? script.replace("$row|ConvertTo-Json -Compress", "[Console]::Out.Write('primitive-returned')")
    : serialization === "system-utility" ? script.replace("$row|ConvertTo-Json -Compress", "[Console]::Error.WriteLine('phase:utility-import');Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;[Console]::Error.WriteLine('phase:utility-loaded');$row|ConvertTo-Json -Compress;[Console]::Error.WriteLine('phase:json-written')")
    : serialization === "framework-json" ? script.replace("$row|ConvertTo-Json -Compress", "[Console]::Error.WriteLine('phase:framework-load');[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35');$json=[Web.Script.Serialization.JavaScriptSerializer]::new();$json.MaxJsonLength=65536;$json.RecursionLimit=8;[Console]::Out.Write($json.Serialize($row));[Console]::Error.WriteLine('phase:json-written')") : script;
  const input = mode === "line" ? Buffer.from(body).toString("base64") + "\n" : body + "\n\n";
  const wrapper = mode === "line"
    ? "[Console]::Error.WriteLine('phase:wrapper-entered');$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()));[Console]::Error.WriteLine('phase:input-read');& ([scriptblock]::Create($s))"
    : "[Console]::Error.WriteLine('phase:wrapper-entered');$s=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('phase:input-read');& ([scriptblock]::Create($s))";
  const args = [...common, mode === "argv" ? body : wrapper];
  const result = await new Promise(resolve => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, env: environment(expanded ? bootstrapKeys : narrowKeys), stdio: [mode === "argv" ? "ignore" : "pipe", "pipe", "pipe"] });
    console.log(JSON.stringify({ event: "planned-and-started", mode, expanded, serialization, pid: child.pid, parent: process.pid, ports: [], windowsHide: true, budgetMs }));
    let timedOut = false, bytes = 0, stdout = "", stderr = "", stdinFinished = mode === "argv";
    const stop = () => { timedOut = true; if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
    const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
    child.once("error", () => {});
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.once("finish", () => { stdinFinished = true; });
      child.stdin.end(input);
    }
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 65536) stop();
      else if (stream === child.stdout) stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer); child.stdin?.destroy();
      let row; try { row = JSON.parse(stdout); } catch { /* Diagnosed below. */ }
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      resolve({ event: "closed", mode, expanded, serialization, pid: child.pid, parent: process.pid, elapsedMs: Math.round(performance.now() - started), code, signal, timedOut, stdinFinished,
        phases: stderr.match(/phase:[a-z-]+/g) || [], stderrBytes: Buffer.byteLength(stderr), stderrDigest: crypto.createHash("sha256").update(stderr).digest("hex"),
        stdoutBytes: Buffer.byteLength(stdout), exactSelf: row?.pid === process.pid, parentMatches: row?.ppid === process.ppid, present: row?.state === "present", birthPresent: typeof row?.birth === "string", ports: [] });
    });
  });
  console.log(JSON.stringify(result));
}
const events = [];
const onProcess = record => { events.push(record); if (["started", "closed"].includes(record.event)) console.log(JSON.stringify({ event: record.event, pid: record.pid, parent: process.pid, code: record.exitCode, signal: record.signal, ports: [] })); };
const actual = await probeNativeProcesses({ startPid: process.pid, stopPid: process.pid, onProcess });
console.log(JSON.stringify({ event: "actual-current-probe", budgetMs: 1500, present: actual?.rows[0]?.state === "present", birthPresent: typeof actual?.rows[0]?.birth === "string" }));
let inventory, inventoryError;
try { inventory = await observeCodexNativeWriters({ onProcess }); } catch (error) { inventoryError = error.code; }
console.log(JSON.stringify({ event: "actual-current-name-inventory", budgetMs: 10000, status: inventory?.status, error: inventoryError }));
await compare("eof", false, "framework-json", 1000); // Before explicit Utility loading; no diagnostic module prewarm.
await compare("argv"); await compare("eof"); await compare("line"); await compare("eof", true);
await compare("eof"); // Bootstrap -> narrow reverses the earlier pair to expose warm/cache effects.
await compare("eof", false, "primitive");
await compare("eof", false, "system-utility", 1000);
for (const event of events.filter(value => value.event === "started")) assert(events.some(value => value.event === "closed" && value.pid === event.pid));
assert.equal(actual?.rows[0]?.state, "present", "Current production self probe failed; stop before the long suite.");
assert.equal(inventory?.status, "observed", "Current production inventory failed; stop before the long suite.");
