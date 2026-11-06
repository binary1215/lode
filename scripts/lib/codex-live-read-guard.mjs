import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeCheck } from "./provider-native-history-host.mjs";
import { nativeSqlitePath } from "./codex-native-backup.mjs";

const owned = new Map();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const databaseNames = ["state_5.sqlite", "thread_history_1.sqlite"];
const SCRIPT = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::Error.WriteLine("[lode-guard-startup-v1] script-started")
[Diagnostics.Process]::GetCurrentProcess().PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal
[Console]::Error.WriteLine("[lode-guard-startup-v1] priority-ready")
# Bind the same fixed read-only WinAPI in memory. No compiler/module discovery,
# executable, external assembly or request-controlled native method is involved.
[Console]::Error.WriteLine("[lode-guard-startup-v1] type-bootstrap")
$guardAssembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('LodeGuardNative'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$guardModule=$guardAssembly.DefineDynamicModule('LodeGuardNative')
# BY_HANDLE_FILE_INFORMATION is exactly thirteen unsigned DWORDs on both ABIs.
$guardFields=@('Attributes','CreationLow','CreationHigh','AccessLow','AccessHigh','WriteLow','WriteHigh','Volume','SizeHigh','SizeLow','Links','IndexHigh','IndexLow')
$guardInfoBuilder=$guardModule.DefineType('LodeGuardFileInformation',[Reflection.TypeAttributes]'Public,Sealed,SequentialLayout,BeforeFieldInit',[ValueType])
foreach($field in $guardFields){[void]$guardInfoBuilder.DefineField($field,[UInt32],[Reflection.FieldAttributes]::Public)}
$guardInfoType=$guardInfoBuilder.CreateType()
if([Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($guardInfoType)) -ne 52){throw 'Invalid native file information size'}
for($i=0;$i -lt $guardFields.Count;$i++){if([Runtime.InteropServices.Marshal]::OffsetOf($guardInfoType,$guardFields[$i]).ToInt32() -ne 4*$i){throw 'Invalid native file information offset'}}
$guardNativeBuilder=$guardModule.DefineType('LodeGuardFileIdentity',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
$guardMethod=$guardNativeBuilder.DefineMethod('GetFileInformationByHandle',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[bool],[Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],$guardInfoType.MakeByRefType()))
$guardConstructor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
$guardAttribute=[Reflection.Emit.CustomAttributeBuilder]::new($guardConstructor,[object[]]@('kernel32.dll'),[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')),[object[]]@($true))
$guardMethod.SetCustomAttribute($guardAttribute)
$guardMethod.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
[void]$guardNativeBuilder.CreateType()
[Console]::Error.WriteLine("[lode-guard-startup-v1] type-ready")
$streams=[Collections.Generic.List[IO.FileStream]]::new()
try {
 $requestLine=[Console]::In.ReadLine()
 [Console]::Error.WriteLine("[lode-guard-startup-v1] request-read")
 $request=$requestLine | ConvertFrom-Json
 [Console]::Error.WriteLine("[lode-guard-startup-v1] request-decoded")
 if($request.version -ne 1 -or @($request.files).Count -ne 4){throw 'Invalid guard request'}
 $files=@()
 foreach($name in $request.files){
  $stream=[IO.FileStream]::new([string]$name,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $streams.Add($stream)
  $info=[Activator]::CreateInstance($guardInfoType)
  if(-not [LodeGuardFileIdentity]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$info)){throw 'GetFileInformationByHandle failed'}
  if($info.Links -ne 1 -or ($info.Attributes -band 1024) -ne 0){throw 'Unsafe guarded file'}
  $files+=@{volume=$info.Volume;fileIndex=('{0:x8}{1:x8}' -f $info.IndexHigh,$info.IndexLow);links=$info.Links;length=$stream.Length.ToString()}
 }
 [Console]::Error.WriteLine("[lode-guard-startup-v1] handles-open")
 @{version=1;ready=$true;pid=$PID;files=$files;share='ReadWrite-no-Delete';powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Depth 6 -Compress
 [Console]::Out.Flush()
 [Console]::Error.WriteLine("[lode-guard-startup-v1] ready-encoded")
 $null=[Console]::In.ReadLine()
} catch {
 @{version=1;ready=$false;pid=$PID;exception=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;message=$_.Exception.Message} | ConvertTo-Json -Compress
 [Console]::Out.Flush()
 exit 2
} finally {
 foreach($stream in $streams){$stream.Dispose()}
 @{version=1;released=$true;pid=$PID} | ConvertTo-Json -Compress
 [Console]::Out.Flush()
}`;
export const CODEX_LIVE_GUARD_SCRIPT_SHA256 = crypto.createHash("sha256").update(SCRIPT).digest("hex");
export const codexLiveReadGuardProcessStatus = () => [...owned.values()].map(value => ({ ...value }));

// Qualified Windows namespace protection only. Existing writers may append,
// checkpoint or truncate; this neither freezes bytes nor forms a global snapshot.
export async function openCodexLiveReadGuard({ home, allowSynchronizationFiles, powershellExecutable,
  signal, assertCurrentAuthority, onProcess = () => {}, timeoutMs = 30000 } = {}) {
  if (allowSynchronizationFiles !== true) fail("CODEX_LIVE_SOURCE_SYNC_POLICY_REQUIRED");
  if (typeof assertCurrentAuthority !== "function") fail("CODEX_LIVE_SOURCE_CURRENT_SCOPE_REQUIRED");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("CODEX_LIVE_SOURCE_DEADLINE_INVALID");
  const scope = () => nativeCheck(signal, () => assertCurrentAuthority({ action: "read-live-codex-source", home, authorityPlane: "P3" }));
  scope();
  if (process.platform !== "win32") return { status: "unsupported-live-source-platform", ordinaryCoreBlocked: false, sqliteOpened: false };
  const root = nativeRoot(home), rootPin = pinNativeRoot(root), paths = [], expected = [];
  for (const database of databaseNames) for (const name of [database, database + "-wal"]) {
    scope(); rootPin.verify();
    const filename = copiedProjectFile(root, name), stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
    if (!stat) return { status: "live-source-component-unavailable", reasonCode: "CODEX_LIVE_SOURCE_EXISTING_DB_AND_WAL_REQUIRED",
      missingComponent: name, ordinaryCoreBlocked: false, sqliteOpened: false };
    if (!stat.isFile() || stat.nlink !== 1n) fail("CODEX_LIVE_SOURCE_FILE_UNSAFE");
    paths.push(filename); expected.push({ dev: String(stat.dev), ino: String(stat.ino) });
  }
  const executable = powershellExecutable ?? path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  if (typeof executable !== "string" || !path.isAbsolute(executable)) fail("CODEX_LIVE_GUARD_HOST_EXECUTABLE_REQUIRED");
  const startedAt = Date.now(), deadline = startedAt + timeoutMs, lines = [], decoder = new StringDecoder("utf8"); let output = "", stderr = "", bytes = 0, primary = null, closed = null, readyConfirmed = false;
  const report = event => { try { onProcess({ purpose: "codex-live-read-guard", scriptSha256: CODEX_LIVE_GUARD_SCRIPT_SHA256,
    windowsHide: true, ports: [], parentPid: process.pid, ...event }); } catch { /* Telemetry is not effect authority. */ } };
  report({ event: "planned", command: executable, args: ["-NoProfile", "-NonInteractive", "-Command", "<fixed-script-by-sha256>"], argumentBody: "fixed script in codex-live-read-guard.mjs" });
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { windowsHide: true, shell: false,
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "Path"].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
  const startupObservation = () => {
    const phases = new Set(["script-started", "priority-ready", "type-bootstrap", "type-ready", "request-read", "request-decoded", "handles-open", "ready-encoded"]);
    const observed = [...stderr.matchAll(/^\[lode-guard-startup-v1\] ([a-z-]+)\r?$/gmu)].map(match => match[1]).filter(phase => phases.has(phase));
    return { phase: observed.at(-1) ?? null, elapsedMs: Math.max(0, Date.now() - startedAt), scriptSha256: CODEX_LIVE_GUARD_SCRIPT_SHA256 };
  };
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const complete = new Promise(resolve => child.once("close", (code, processSignal) => {
    closed = { code, signal: processSignal }; owned.delete(child.pid); report({ event: "closed", pid: child.pid, ...closed });
    if (!lines.some(line => Object.hasOwn(line, "ready"))) rejectReady(primary ?? Object.assign(new Error("CODEX_LIVE_GUARD_CLOSED_BEFORE_READY"), { code: "CODEX_LIVE_GUARD_CLOSED_BEFORE_READY", guardProcessFailure: { code, signal: processSignal, stderr } }));
    resolve(closed);
  }));
  const remember = error => { primary ??= error; rejectReady(primary); };
  child.once("error", remember); child.stdin.on("error", remember);
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 65536) { remember(Object.assign(new Error("CODEX_LIVE_GUARD_PROTOCOL_LIMIT"), { code: "CODEX_LIVE_GUARD_PROTOCOL_LIMIT" })); return; }
    output += decoder.write(chunk);
    while (output.includes("\n")) {
      const end = output.indexOf("\n"), line = output.slice(0, end); output = output.slice(end + 1);
      try { const value = JSON.parse(line); lines.push(value); if (Object.hasOwn(value, "ready")) resolveReady(value); }
      catch (error) { remember(Object.assign(error, { code: "CODEX_LIVE_GUARD_PROTOCOL_INVALID" })); }
    }
  });
  child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 65536) remember(Object.assign(new Error("CODEX_LIVE_GUARD_PROTOCOL_LIMIT"), { code: "CODEX_LIVE_GUARD_PROTOCOL_LIMIT" })); else stderr += chunk.toString("utf8"); });
  if (child.pid) { owned.set(child.pid, { pid: child.pid, parentPid: process.pid, command: executable, windowsHide: true }); report({ event: "started", pid: child.pid, command: executable }); }
  let released = false;
  const release = async () => {
    if (released) return closed; released = true;
    if (!closed) child.stdin.end("release\n");
    let timer;
    const ended = await Promise.race([complete, new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
    clearTimeout(timer);
    if (!ended) { if (!closed) child.kill("SIGTERM"); await complete; fail("CODEX_LIVE_GUARD_RELEASE_TIMEOUT"); }
    if (readyConfirmed && (ended.code !== 0 || !lines.some(line => line.released === true))) fail("CODEX_LIVE_GUARD_RELEASE_UNCONFIRMED");
    return ended;
  };
  const check = () => {
    if (primary) throw primary;
    try {
      scope(); rootPin.verify();
      if (closed || released) fail("CODEX_LIVE_GUARD_NOT_HELD");
      if (Date.now() > deadline) fail("CODEX_LIVE_SOURCE_DEADLINE_EXCEEDED");
      for (const [index, filename] of paths.entries()) {
        const current = fs.lstatSync(copiedProjectFile(root, path.basename(filename)), { bigint: true });
        if (!current.isFile() || current.nlink !== 1n || String(current.dev) !== expected[index].dev || String(current.ino) !== expected[index].ino) fail("CODEX_LIVE_SOURCE_IDENTITY_CHANGED");
      }
    } catch (error) { primary ??= error; throw primary; }
  };
  let timer, abort;
  try {
    child.stdin.write(JSON.stringify({ version: 1, files: paths.map(nativeSqlitePath) }) + "\n");
    const observed = await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("CODEX_LIVE_GUARD_START_TIMEOUT"), { code: "CODEX_LIVE_GUARD_START_TIMEOUT" })), timeoutMs);
      abort = () => reject(Object.assign(new Error("CODEX_LIVE_SOURCE_CANCELLED"), { code: "CODEX_LIVE_SOURCE_CANCELLED" })); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    })]);
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    if (observed.ready !== true) throw Object.assign(new Error(observed.message || "CODEX_LIVE_GUARD_ACQUIRE_FAILED"), { code: "CODEX_LIVE_GUARD_ACQUIRE_FAILED", guardOriginalFailure: observed });
    if (observed.version !== 1 || observed.pid !== child.pid || observed.share !== "ReadWrite-no-Delete" || !Array.isArray(observed.files) || observed.files.length !== paths.length) fail("CODEX_LIVE_GUARD_PROTOCOL_INVALID");
    for (const [index, file] of observed.files.entries()) if (String(file.volume) !== expected[index].dev || BigInt("0x" + file.fileIndex).toString() !== expected[index].ino || file.links !== 1) fail("CODEX_LIVE_SOURCE_IDENTITY_CHANGED");
    readyConfirmed = true;
    check();
    return { status: "live-source-read-guard-held", root, paths, databases: databaseNames, check, release,
      evidence: { platform: process.platform, node: process.version, sqlite: process.versions.sqlite, powershell: observed.powershell,
        files: paths.map((filename, index) => ({ name: path.basename(filename), identity: expected[index] })), namespaceGuard: "delete-rename-only-not-byte-freeze",
        writerQuiescenceClaimed: false, globalAtomicSnapshotClaimed: false, scriptSha256: CODEX_LIVE_GUARD_SCRIPT_SHA256 } };
  } catch (error) {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    primary ??= error;
    if (!readyConfirmed) {
      const observation = startupObservation();
      try { primary.guardStartupObservation ??= observation; } catch { /* Preserve a frozen original error. */ }
      report({ event: "startup-failed", observation });
    }
    try { await release(); } catch (cleanup) { primary.guardCleanupFailure = cleanup.code || cleanup.message; }
    throw primary;
  }
}

export async function withLiveCodexReadSnapshots(options, consume) {
  if (typeof consume !== "function") fail("CODEX_LIVE_SOURCE_READER_REQUIRED");
  const guard = await openCodexLiveReadGuard(options);
  if (guard.status !== "live-source-read-guard-held") return guard;
  const connections = []; let primary = null, value;
  try {
    for (const name of databaseNames) {
      guard.check();
      const db = new DatabaseSync(nativeSqlitePath(copiedProjectFile(guard.root, name)), { readOnly: true });
      const entry = { name, db, transaction: false }; connections.push(entry);
      db.exec("BEGIN"); entry.transaction = true;
    }
    value = await consume({ connections: Object.fromEntries(connections.map(entry => [entry.name, entry.db])), check: guard.check,
      evidence: guard.evidence, sourceSnapshotScope: "independent-DB-read-transactions-first-read-establishes-each-snapshot-not-global-atomic" });
    guard.check();
  } catch (error) { primary = error; }
  finally {
    for (const entry of connections.reverse()) {
      try { if (entry.transaction) entry.db.exec("ROLLBACK"); } catch (error) { if (primary) primary.sourceTransactionCleanupFailure = error.code || error.message; else primary = error; }
      try { entry.db.close(); } catch (error) { if (primary) primary.sourceConnectionCleanupFailure = error.code || error.message; else primary = error; }
    }
    try { await guard.release(); } catch (error) { if (primary) primary.guardCleanupFailure = error.code || error.message; else primary = error; }
  }
  if (primary) throw primary;
  return { status: "live-source-components-observed", authorityPlane: "P3", value, evidence: guard.evidence,
    cleanup: "reader-connections-closed-before-owned-guard-release", globalAtomicSnapshotClaimed: false,
    nativePublicationAttempted: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}
