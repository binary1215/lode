import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Private same-local-environment witness, not a public PID input or process
// controller. Never enumerate a process table or Claude sessions directory.
const hash = x => crypto.createHash("sha256").update(x).digest("hex");
const pidValue = x => Number.isSafeInteger(x) && x > 0 && x <= 0xffffffff;
export const NATIVE_PROCESS_LIMITS = Object.freeze({ depth: 8, known: 16, timeoutMs: 1500, outputBytes: 64 * 1024 });
function registry(pid, nativeSessionId, environment) {
  const config = environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  if (!path.isAbsolute(config)) return false;
  const directory = path.join(config, "sessions"), file = path.join(directory, `${pid}.json`);
  let current = path.parse(file).root;
  try {
    for (const part of file.slice(current.length).split(path.sep)) {
      current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return false;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && value.sessionId === nativeSessionId && (value.pid === undefined || value.pid === pid);
  } catch { return false; }
}
function linuxRow(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    if (!/^\d+$/u.test(fields[19] || "") || !Number.isSafeInteger(Number(fields[1]))) return { pid, state: "unknown" };
    return { pid, ppid: Number(fields[1]), birth: fields[19], state: ["Z", "X"].includes(fields[0]) ? "gone" : "present" };
  } catch (e) { return { pid, state: e.code === "ENOENT" || e.code === "ESRCH" ? "gone" : "unknown" }; }
}
function linuxProbe({ startPid, stopPid, pids, deadlineAt = null }) {
  const environment = hash(JSON.stringify(["linux", os.hostname(), fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), fs.readlinkSync("/proc/self/ns/pid")]));
  const rows = [];
  if (startPid) {
    let id = startPid;
    for (let depth = 0; depth <= NATIVE_PROCESS_LIMITS.depth && pidValue(id); depth++) {
      if (deadlineAt !== null && Date.now() >= deadlineAt) return null;
      const row = linuxRow(id); rows.push(row);
      if (row.state !== "present" || row.ppid === id || id === stopPid) break;
      id = row.ppid;
    }
  } else for (const id of pids) { if (deadlineAt !== null && Date.now() >= deadlineAt) return null; rows.push(linuxRow(id)); }
  return { environment, rows };
}
function windowsProbe({ startPid, stopPid, pids, onProcess = () => {}, timeoutMs = NATIVE_PROCESS_LIMITS.timeoutMs, deadlineAt = null }) {
  const ids = (pids || []).filter(pidValue), start = pidValue(startPid) ? startPid : 0;
  // Reflection.Emit avoids compiler children and framework GetProcessById's
  // hidden EnumProcesses fallback. This is the same query-only Win32 primitive
  // as the native supervisor's owner observer, not job/lease/kill control.
  const interop = `
$taskAssembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('HeadExactProcessQuery'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$taskModule=$taskAssembly.DefineDynamicModule('HeadExactProcessQuery')
$taskType=$taskModule.DefineType('HeadExactProcessQuery',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Add-TaskQueryMethod([string]$taskName,[Type]$taskReturn,[Type[]]$taskParameters){
  $taskMethod=$taskType.DefineMethod($taskName,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$taskReturn,$taskParameters)
  $taskConstructor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
  $taskAttribute=[Reflection.Emit.CustomAttributeBuilder]::new($taskConstructor,[object[]]@('kernel32.dll'),[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')),[object[]]@($true))
  $taskMethod.SetCustomAttribute($taskAttribute)
  $taskMethod.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  if($taskName -eq 'OpenProcess'){$script:taskOpenMethod=$taskMethod}
}
Add-TaskQueryMethod 'OpenProcess' ([IntPtr]) ([Type[]]@([UInt32],[bool],[UInt32]))
Add-TaskQueryMethod 'GetProcessTimes' ([bool]) ([Type[]]@([IntPtr],[UInt64].MakeByRefType(),[UInt64].MakeByRefType(),[UInt64].MakeByRefType(),[UInt64].MakeByRefType()))
Add-TaskQueryMethod 'WaitForSingleObject' ([UInt32]) ([Type[]]@([IntPtr],[UInt32]))
Add-TaskQueryMethod 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
$taskOpenExact=$taskType.DefineMethod('OpenExact',[Reflection.MethodAttributes]'Public,Static',[IntPtr],[Type[]]@([UInt32],[Int32].MakeByRefType()))
$taskIL=$taskOpenExact.GetILGenerator()
[void]$taskIL.DeclareLocal([IntPtr])
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldc_I4,[int]0x00101000)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldc_I4_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Call,[Reflection.MethodInfo]$script:taskOpenMethod)
$taskIL.Emit([Reflection.Emit.OpCodes]::Stloc_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_1)
$taskIL.Emit([Reflection.Emit.OpCodes]::Call,[Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'))
$taskIL.Emit([Reflection.Emit.OpCodes]::Stind_I4)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldloc_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ret)
[void]$taskType.CreateType()
function Read-TaskExactProcess([UInt32]$taskId,[bool]$taskNeedParent,[bool]$taskOwn){
  [int]$taskError=0
  $taskHandle=[HeadExactProcessQuery]::OpenExact($taskId,[ref]$taskError)
  if($taskHandle -eq [IntPtr]::Zero){return @{pid=[long]$taskId;state=$(if($taskError -eq 87){'gone'}else{'unknown'});errorCode=$taskError}}
  try{
    [UInt64]$taskCreated=0;[UInt64]$taskExited=0;[UInt64]$taskKernel=0;[UInt64]$taskUser=0
    if(![HeadExactProcessQuery]::GetProcessTimes($taskHandle,[ref]$taskCreated,[ref]$taskExited,[ref]$taskKernel,[ref]$taskUser)){return @{pid=[long]$taskId;state='unknown'}}
    $taskWait=[HeadExactProcessQuery]::WaitForSingleObject($taskHandle,0)
    if($taskWait -eq 0){return @{pid=[long]$taskId;state='gone'}}
    if($taskWait -ne 258){return @{pid=[long]$taskId;state='unknown'}}
    $taskParent=0
    if($taskNeedParent){
      if($taskOwn){$taskParent=${process.ppid}}
      else{
        $taskInfo=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$taskId) -Property ProcessId,ParentProcessId,CreationDate
        if($null -eq $taskInfo -or $taskInfo.ProcessId -ne $taskId -or [DateTime]::FromFileTimeUtc([long]$taskCreated).ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne $taskInfo.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')){return @{pid=[long]$taskId;state='unknown'}}
        $taskParent=[long]$taskInfo.ParentProcessId
      }
    }
    return @{pid=[long]$taskId;ppid=$taskParent;birth=('windows-filetime-'+$taskCreated.ToString([Globalization.CultureInfo]::InvariantCulture));state='present'}
  }catch{return @{pid=[long]$taskId;state='unknown'}}
  finally{[void][HeadExactProcessQuery]::CloseHandle($taskHandle)}
}
`;
  const script = `$ErrorActionPreference='Stop'; ${interop}
$taskMachine=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography','MachineGuid',$null)
if($taskMachine -isnot [string] -or !$taskMachine){exit 1}
$taskRows=@();$taskIds=@(${ids.join(",")});$taskNext=${start}
for($taskIndex=0;$taskIndex -lt ${start ? NATIVE_PROCESS_LIMITS.depth + 1 : ids.length};$taskIndex++){
  $taskId=if(${start} -gt 0){$taskNext}else{$taskIds[$taskIndex]}
  if($taskId -le 0){break}
  # A terminal registry row needs identity/liveness, not its unused parent.
  # ppid=0 retains the existing unknown/not-requested meaning.
  $taskNeedParent=(${start} -gt 0 -and $taskId -ne ${pidValue(stopPid) ? stopPid : 0})
  $taskRow=Read-TaskExactProcess $taskId $taskNeedParent $(${start === process.pid ? "$taskIndex -eq 0" : "$false"})
  $taskRows+=@($taskRow)
  if(${start} -gt 0){if($taskRow.state -ne 'present' -or $taskId -eq ${pidValue(stopPid) ? stopPid : 0}){break};$taskNext=$taskRow.ppid}
}
@{machine=$taskMachine;hostName=[Environment]::MachineName;rows=@($taskRows)} | ConvertTo-Json -Compress -Depth 4`;
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Same exact query, delivered on stdin rather than a large encoded command
  // line. No script file, policy change, daemon or additional runtime is needed.
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"];
  const report = (record) => { try { onProcess(record); } catch { /* Logging is not control authority. */ } };
  report({ event: "planned", command: executable, arguments: args, inputBytes: Buffer.byteLength(script), inputDigest: hash(script),
    cwd: process.cwd(), parent: process.pid, ports: [], windowsHide: true });
  return new Promise(resolve => {
    let child, timer, bytes = 0, failed = false; const chunks = [];
    if (deadlineAt !== null && Date.now() >= deadlineAt) { resolve(null); return; }
    try {
      child = spawn(executable, args, { windowsHide: true, shell: false, cwd: process.cwd(),
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: ["pipe", "pipe", "pipe"] });
    } catch { resolve(null); return; }
    report({ event: "started", pid: child.pid, parent: process.pid, command: executable, arguments: args, cwd: process.cwd(), ports: [] });
    const stop = () => {
      failed = true;
      // Exact task-owned helper only. It launches no native subprocesses; never
      // signal a witnessed Claude engine or an unknown/reused PID.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    // spawn can itself be slow on Windows. Never grant that elapsed time again.
    const remaining = deadlineAt === null ? timeoutMs : Math.max(0, deadlineAt - Date.now());
    timer = setTimeout(stop, remaining);
    if (remaining === 0) stop();
    child.stdin.on("error", stop);
    try { child.stdin.end(script + "\n\n"); } catch { stop(); }
    for (const stream of [child.stdout, child.stderr]) stream.on("data", b => {
      bytes += b.length; if (bytes > NATIVE_PROCESS_LIMITS.outputBytes) stop();
      else if (stream === child.stdout) chunks.push(b);
    });
    child.once("error", () => { failed = true; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      report({ event: "closed", pid: child.pid, parent: process.pid, exitCode: code, signal, ports: [] });
      if (failed || code !== 0) { resolve(null); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, ""));
        if (typeof value.machine !== "string" || !value.machine || typeof value.hostName !== "string") { resolve(null); return; }
        report({ event: "identity-projection", pid: child.pid, rows: value.rows, ports: [] });
        resolve({ environment: hash(JSON.stringify(["win32", value.machine, value.hostName])), rows: value.rows });
      } catch { resolve(null); }
    });
  });
}
export async function probeNativeProcesses({ startPid = null, stopPid = null, pids = [], platform = process.platform, onProcess, deadlineAt = null } = {}) {
  if (startPid !== null && !pidValue(startPid) || !Array.isArray(pids) || pids.length > NATIVE_PROCESS_LIMITS.known || pids.some(p => !pidValue(p))) return null;
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt)) return null;
  try {
    const timeoutMs = deadlineAt === null ? NATIVE_PROCESS_LIMITS.timeoutMs : Math.min(NATIVE_PROCESS_LIMITS.timeoutMs, Math.max(1, deadlineAt - Date.now()));
    const result = platform === "linux" ? linuxProbe({ startPid, stopPid, pids, deadlineAt })
      : platform === "win32" ? await windowsProbe({ startPid, stopPid, pids, onProcess, timeoutMs, deadlineAt }) : null;
    if (deadlineAt !== null && Date.now() >= deadlineAt) return null;
    if (!result || !/^[a-f0-9]{64}$/u.test(result.environment) || !Array.isArray(result.rows)
      || result.rows.length > (startPid ? NATIVE_PROCESS_LIMITS.depth + 1 : NATIVE_PROCESS_LIMITS.known)
      || result.rows.some(r => !pidValue(r.pid) || !["present", "gone", "unknown"].includes(r.state)
        || r.state === "present" && (!Number.isSafeInteger(r.ppid) || r.ppid < 0 || typeof r.birth !== "string" || !r.birth || r.birth.length > 128))) return null;
    return result;
  } catch { return null; }
}
function birthNumber(value, platform) {
  const prefix = platform === "win32" ? "windows-filetime-" : "";
  if (typeof value !== "string" || !value.startsWith(prefix) || !/^\d+$/u.test(value.slice(prefix.length))) return null;
  try { return BigInt(value.slice(prefix.length)); } catch { return null; }
}
function notAfter(parent, child, platform) {
  const a = birthNumber(parent, platform), b = birthNumber(child, platform);
  return a !== null && b !== null && a <= b;
}
export async function observeClaudeProcess({ nativeSessionId, environment = process.env, platform = process.platform,
  probe = probeNativeProcesses, onProcess, deadlineAt = null } = {}) {
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt)) return null;
  const stopPid = registry(process.pid, nativeSessionId, environment) ? process.pid
    : registry(process.ppid, nativeSessionId, environment) ? process.ppid : null;
  const result = await probe({ startPid: process.pid, stopPid, platform, onProcess, deadlineAt });
  if (deadlineAt !== null && Date.now() >= deadlineAt) return null;
  if (!result || result.rows[0]?.pid !== process.pid) return null;
  let previous = null;
  for (const row of result.rows) {
    if (row.state !== "present" || previous && (previous.ppid !== row.pid || !notAfter(row.birth, previous.birth, platform))) break;
    if (registry(row.pid, nativeSessionId, environment)) return { pid: row.pid, ppid: row.ppid, birth: row.birth, environment: result.environment, platform };
    previous = row;
  }
  return null;
}
export async function probeClaudeProcesses({ instances, nativeSessionId, environment = process.env, platform = process.platform,
  probe = probeNativeProcesses, onProcess } = {}) {
  const unique = [...new Map(instances.filter(x => x.platform === platform).map(x => [x.environment + ":" + x.pid + ":" + x.birth, x])).values()]
    .slice(0, NATIVE_PROCESS_LIMITS.known);
  if (!unique.length) return [];
  const result = await probe({ pids: [...new Set(unique.map(x => x.pid))], platform, onProcess });
  return unique.map(instance => {
    const current = result?.environment === instance.environment && result.rows.find(r => r.pid === instance.pid);
    let state = "unknown";
    if (birthNumber(instance.birth, platform) !== null) {
      if (current?.state === "gone" || current?.state === "present" && birthNumber(current.birth, platform) !== null && current.birth !== instance.birth) state = "ended-at-check";
      else if (current?.state === "present" && current.birth === instance.birth && registry(instance.pid, nativeSessionId, environment)) state = "live-at-check";
    }
    return { pid: instance.pid, birth: instance.birth, environment: instance.environment, platform: instance.platform, state, checkedAt: new Date().toISOString(),
      scope: "observed-hosting-instance-not-agent-activity" };
  });
}
