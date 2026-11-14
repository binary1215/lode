import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { resolveProjectStorage } from "../storage/project-storage-format.mjs";
import { resolveRuntimeOperationalStateRoot } from "../runtime/runtime-execution-lease.mjs";
import { withLocalMutation } from "../storage/project-mutation-lock.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { renamePath } from "../core/fs-atomic.mjs";

// Local P5 reference only. It is not Canon, a checkpoint, direction, or an
// instruction. The checkpoint remains the recovery source.
export const USER_PROMPT_REFERENCE_LIMITS = Object.freeze({ prompts: 3, characters: 2000, bytes: 16 * 1024 });
const LABEL =
  "Lode user-prompt reference (non-authoritative; earlier excerpts, not a recovery record, current instructions or approval). Current user direction and the selected Session's saved recovery record take precedence.";
const preparations = new WeakMap();
const operations = new WeakMap();
const require = createRequire(import.meta.url);
const exactStat = (file) => fs.lstatSync(file, { bigint: true });
const exactDescriptorStat = (descriptor) => fs.fstatSync(descriptor, { bigint: true });

function redact(text) {
  return (
    text
      // The scan is bounded before matching. An unfinished key masks to the end
      // rather than leaking its first 2000 characters after truncation.
      .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gi, "[redacted-private-key]")
      .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{4,}/gi, "[redacted-token]")
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{4,}/gi, "[redacted-token]")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{4,}/g, "[redacted-token]")
      .replace(/\b(authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic))[ \t]+[A-Za-z0-9._~+\/=\-]+/gi, "$1 [redacted-token]")
      .replace(/\b(Bearer|Basic)[ \t]+([A-Za-z0-9._~+\/=\-]{4,})/gi, (match, scheme, token) => {
        const value = token.endsWith(".") ? token.slice(0, -1) : token;
        if (scheme.toLowerCase() === "basic") {
          // Without an Authorization field, ordinary "Basic Implementation" is
          // prose. A Basic credential is base64(user:password), even if unpadded.
          if (!/^[A-Za-z0-9+/]+=*$/.test(value) || !Buffer.from(value, "base64").includes(0x3a)) return match;
        } else if (!/[0-9._~+\/=\-]/.test(value) && value.length < 16) return match;
        return scheme + " [redacted-token]" + (value.length < token.length ? "." : "");
      })
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{4,}/gi, "[redacted-token]")
      // Assignment syntax is required: discussion of passwords is ordinary prose.
      .replace(
        /\b(password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}]+)/gi,
        "$1$2[redacted-token]",
      )
  );
}

function boundText(text) {
  const clean = redact(
    text
      .slice(0, USER_PROMPT_REFERENCE_LIMITS.bytes)
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
  ).trim();
  if (!clean) return "";
  return clean.length > USER_PROMPT_REFERENCE_LIMITS.characters ? clean.slice(0, USER_PROMPT_REFERENCE_LIMITS.characters) : clean;
}

// stageWanted(existingFile) says whether this operation will probably write.
// On Windows the private stage for that write is then created in the same
// helper call that verifies the directory and the existing file. A wrong
// guess costs only time: an unused stage is removed by discardStage, and a
// missing one is created by writePrivate as before.
function callerFile(root, runtime, nativeSessionId, agentId, environment, create, permissions, stageWanted = null) {
  checkBudget(permissions);
  if (!["claude", "codex", "opencode"].includes(runtime) || typeof nativeSessionId !== "string" || !nativeSessionId) return null;
  const projectRoot = fs.realpathSync(path.resolve(root));
  const storage = resolveProjectStorage(projectRoot);
  if (!storage) return null;
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot, storage, environment, create });
  const digest = sha256Hex(JSON.stringify([storage.projectId, runtime, nativeSessionId, agentId || null]));
  const directory = path.join(operational, "user-prompt-reference");
  if (!fs.existsSync(directory)) {
    if (!create) return null;
    try {
      if (process.platform === "win32") windowsPrivate([{ path: directory, kind: "directory", create: true }], permissions);
      else fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const file = path.join(directory, digest + ".json");
  permissions.lock = path.join(operational, ".user-prompt-locks", digest + ".lock");
  const existing = fs.existsSync(file) ? file : null;
  privateDirectory(directory, permissions, existing, process.platform === "win32" && stageWanted?.(existing) ? file : null);
  return file;
}

const stagePath = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);

// Removes a stage created for this operation and not used by writePrivate,
// only while it is still the exact empty file proven by its receipt.
function discardStage(permissions) {
  const stage = permissions.stage;
  permissions.stage = null;
  if (!stage?.entry || stage.used) return;
  try {
    const entry = exactStat(stage.path);
    if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.size === 0n && sameEntry(stage.entry, entry)) fs.unlinkSync(stage.path);
  } catch {
    /* Already gone, or no longer this call's empty stage: leave it. */
  }
}

// Dedicated P5 plaintext storage only. Never change permissions of the general
// operational/artifact directories. Windows checks token SID and protected DACL
// on this dedicated store; POSIX mode bits are not Windows privacy evidence.
// The script reaches PowerShell over stdin after the request line (see
// WINDOWS_PRIVATE_ACL_COMMAND) and reads the request from $lodeRequest. It stays
// printable ASCII: Windows PowerShell 5.1 decodes stdin with the console code
// page. Its last line is the end marker the command requires before it parses
// anything; the try/catch around the body is a second barrier.
export const WINDOWS_PRIVATE_ACL = String.raw`
$ErrorActionPreference='Stop'
try {
  # The parser ConvertFrom-Json uses in Windows PowerShell 5.1, without loading
  # its module or converting the result: an array of key/value dictionaries.
  $requests=[Web.Script.Serialization.JavaScriptSerializer, System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35]::new().DeserializeObject($lodeRequest)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if (@(foreach($each in @($requests)){if($each.create -eq $true){$each}}).Count -gt 0) {
    $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('LodePrivateCreation'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module=$assembly.DefineDynamicModule('LodePrivateCreation')
    $type=$module.DefineType('LodePrivateCreation',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
    foreach($spec in @(
      @{name='CreateDirectoryW';result=[bool];args=[Type[]]@([string],[IntPtr])},
      @{name='GetFileInformationByHandle';result=[bool];args=[Type[]]@([IntPtr],[IntPtr])},
      @{name='SetFileInformationByHandle';result=[bool];args=[Type[]]@([IntPtr],[int],[IntPtr],[uint32])}
    )) {
      $method=$type.DefinePInvokeMethod($spec.name,'kernel32.dll',$spec.name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$spec.result,$spec.args,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
      $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    }
    [void]$type.CreateType()
  }
  function New-PrivateAcl([bool]$directory) {
    $next=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $next.SetOwner($sid); $next.SetAccessRuleProtection($true,$false)
    $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach ($principal in @($sid,$system)) {
      $next.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    return $next
  }
  # The object Get-Item returns for a file system path, without the provider:
  # attributes of the entry itself (a link is not followed), then
  # DirectoryInfo or FileInfo. A missing path throws.
  function Get-PrivateItem([string]$target) {
    if (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Directory) -ne 0) {return [IO.DirectoryInfo]::new($target)}
    return [IO.FileInfo]::new($target)
  }
  foreach ($request in @($requests)) {
  $directory=$request.kind -eq 'directory'
  if ($request.create -eq $true) {
    # Explicit security is supplied to creation itself: an elevated token's
    # default owner is not necessarily its User SID. Existing owners are never
    # adopted. Both native create operations refuse collisions unchanged.
    $security=New-PrivateAcl $directory
    if($directory){
      $bytes=$security.GetSecurityDescriptorBinaryForm()
      $pin=[Runtime.InteropServices.GCHandle]::Alloc($bytes,[Runtime.InteropServices.GCHandleType]::Pinned)
      $width=[IntPtr]::Size;$length=if($width -eq 8){24}else{12}
      $attributes=[IntPtr]::Zero
      try{
        $attributes=[Runtime.InteropServices.Marshal]::AllocHGlobal($length)
        [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($length),0,$attributes,$length)
        [Runtime.InteropServices.Marshal]::WriteInt32($attributes,$length)
        [Runtime.InteropServices.Marshal]::WriteIntPtr($attributes,$width,$pin.AddrOfPinnedObject())
        if(-not [LodePrivateCreation]::CreateDirectoryW($request.path,$attributes)){throw 'create-collision-or-denied'}
      }finally{if($attributes -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::FreeHGlobal($attributes)};$pin.Free()}
    }
    else{
      # Failure closes/deletes this exact empty object, never a path replacement.
      $stage=[IO.FileStream]::new($request.path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,1,[IO.FileOptions]::DeleteOnClose,$security)
      $info=[IntPtr]::Zero
      try{
        $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
        $stageAcl=$stage.GetAccessControl()
        if($stageAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'created-owner'}
        if(-not [LodePrivateCreation]::GetFileInformationByHandle($stage.SafeFileHandle.DangerousGetHandle(),$info)){throw 'created-identity'}
        $volume=[uint32]([Runtime.InteropServices.Marshal]::ReadInt32($info,28) -band [long]4294967295)
        $high=[uint32]([Runtime.InteropServices.Marshal]::ReadInt32($info,44) -band [long]4294967295)
        $low=[uint32]([Runtime.InteropServices.Marshal]::ReadInt32($info,48) -band [long]4294967295)
        $index=([uint64]$high -shl 32) -bor [uint64]$low
        # Receipt is flushed BEFORE disabling delete-on-close. Even on later
        # timeout/failure Node can clean only this exact proven file identity.
        # Both values are decimal digits only; no JSON escaping is needed.
        [Console]::Out.WriteLine('{"created":{"dev":"'+$volume.ToString()+'","ino":"'+$index.ToString()+'"}}')
        [Console]::Out.Flush()
        # FileDispositionInfo cannot cancel FILE_FLAG_DELETE_ON_CLOSE.
        # FileDispositionInfoEx + ON_CLOSE (without DELETE) clears that flag.
        [Runtime.InteropServices.Marshal]::WriteInt32($info,8)
        if(-not [LodePrivateCreation]::SetFileInformationByHandle($stage.SafeFileHandle.DangerousGetHandle(),21,$info,4)){throw 'created-publication'}
      }finally{if($info -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::FreeHGlobal($info)};$stage.Dispose()}
    }
  }
  $item=Get-PrivateItem $request.path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse'}
  if ($directory -ne ($item -is [IO.DirectoryInfo])) {throw 'type'}
  $acl=$item.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'owner'}
  function PrivateAcl($value) {
    if (-not $value.AreAccessRulesProtected) {return $false}
    $rules=@($value.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) {return $false}
    foreach ($principal in @($sid,$system)) {
      $rule=@(foreach($each in $rules){if($each.IdentityReference.Value -eq $principal.Value){$each}})
      if ($rule.Count -ne 1 -or $rule[0].IsInherited -or $rule[0].AccessControlType -ne 'Allow' -or
        $rule[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {return $false}
      $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
      if ($rule[0].InheritanceFlags -ne $inherit -or $rule[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {return $false}
    }
    return $true
  }
  if (-not (PrivateAcl $acl)) {
    if($request.create -eq $true){throw 'created-acl'}
    $next=New-PrivateAcl $directory
    $item.SetAccessControl($next)
  }
  $verified=Get-PrivateItem $request.path
  if (($verified.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $directory -ne ($verified -is [IO.DirectoryInfo])) {throw 'changed'}
  $acl=$verified.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not (PrivateAcl $acl)) {throw 'unverified'}
  }
  [Console]::Out.Write('private')
} catch {[Console]::Error.Write($_.Exception.Message);exit 1}
#lode-private-acl-end
`;
// Short and fixed: no script body or request data on the command line (a new
// long command line costs about 0.25-0.3 s on the first child of a process).
// Unless the text after the request line ends with the script's end marker
// (ordinal comparison, trailing whitespace ignored), it exits 3 without
// parsing or running any of it; so every incomplete script is refused.
// Otherwise [scriptblock]::Create parses the whole script before it runs.
export const WINDOWS_PRIVATE_ACL_COMMAND =
  "$lodeRequest=[Console]::In.ReadLine(); $lodeScript=[Console]::In.ReadToEnd(); if(-not $lodeScript.TrimEnd().EndsWith('#lode-private-acl-end',[StringComparison]::Ordinal)){exit 3}; & ([scriptblock]::Create($lodeScript))";

const privatePermissions = (deadlineAt = null) => ({
  checked: new Set(),
  wallDeadline: deadlineAt,
  deadline: performance.now() + (deadlineAt === null ? 5000 : Math.max(0, Math.min(5000, deadlineAt - Date.now()))),
  failed: false,
});
function checkBudget(permissions) {
  if (
    permissions.failed ||
    performance.now() >= permissions.deadline ||
    (permissions.wallDeadline !== null && (!Number.isSafeInteger(permissions.wallDeadline) || Date.now() >= permissions.wallDeadline))
  ) {
    permissions.failed = true;
    throw new Error("Private prompt operation deadline exceeded.");
  }
}
// Internal Hook budget, not a read capability or public Core surface. Transfer,
// prepare and acknowledgement share one finite operation and checked entries.
export function createUserPromptReferenceOperation({ deadlineAt } = {}) {
  const operation = Object.freeze({});
  operations.set(operation, privatePermissions(deadlineAt));
  return operation;
}
function operationPermissions(operation) {
  if (operation === undefined) return privatePermissions();
  const permissions = operation && operations.get(operation);
  if (!permissions) throw new Error("Unknown prompt operation.");
  checkBudget(permissions);
  return permissions;
}

// Every UTF-16 code unit outside printable ASCII becomes \uXXXX (surrogate
// pairs stay pairs), so the JSON text decodes to the same strings.
const asciiJson = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));

// requests: one object, or a batch of the store directory followed by files
// directly inside it (existing ones first, at most one new stage last).
function windowsPrivate(requests, permissions, onCreate = null) {
  checkBudget(permissions);
  // Never accept a general artifact path, arbitrary script or caller body.
  if (permissions.failed) throw new Error("Private prompt ACL verification already failed.");
  const [first] = requests,
    file = first?.path,
    creates = requests.filter((request) => request.create);
  if (
    !requests.length ||
    requests.some((request) => typeof request.path !== "string" || !["directory", "file"].includes(request.kind)) ||
    creates.length > 1 ||
    (requests.length > 1 &&
      (first.kind !== "directory" ||
        first.create ||
        requests.slice(1).some((request) => request.kind !== "file" || path.dirname(request.path) !== file) ||
        (creates.length && creates[0] !== requests.at(-1))))
  )
    throw new Error("Unsafe prompt ACL batch.");
  const stageRequest = creates[0]?.kind === "file" ? creates[0] : null;
  const pending = requests
    .map((request) => {
      const directory = request.kind === "directory",
        target = request.path;
      if (
        directory
          ? path.basename(target) !== "user-prompt-reference"
          : path.basename(path.dirname(target)) !== "user-prompt-reference" ||
            !/^(?:[a-f0-9]{64}\.json|\.[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp)$/.test(path.basename(target))
      )
        throw new Error("Unsafe prompt ACL target.");
      let stat;
      try {
        stat = exactStat(target);
      } catch (error) {
        if (!request.create || error.code !== "ENOENT") throw error;
      }
      if (stat && (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)))
        throw new Error("Unsafe prompt ACL entry.");
      if (request.create && stat) throw new Error("Prompt creation target already exists.");
      return { request, stat, identity: stat ? JSON.stringify([request.kind, String(stat.dev), String(stat.ino)]) : null };
    })
    .filter((item) => !permissions.checked.has(item.identity));
  // Local to one synchronous capture/freeze/take. Never cache ACLs across turns
  // or callers. Renaming a verified stage within this directory keeps its DACL;
  // each filesystem use still rejects links/replacements by exact entry ID.
  if (!pending.length) return;
  const remaining = Math.floor(permissions.deadline - performance.now());
  if (remaining <= 0) {
    permissions.failed = true;
    throw new Error("Private prompt operation deadline exceeded.");
  }
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const result = childProcess.spawnSync(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_PRIVATE_ACL_COMMAND],
      {
        cwd: path.dirname(file),
        windowsHide: true,
        shell: false,
        // Windows PowerShell decodes stdin with the console code page. Plain
        // ASCII JSON (\uXXXX escapes, so never a raw line break) on the first
        // line reaches it intact under any code page; the script follows.
        input: asciiJson(pending.map((item) => item.request)) + "\n" + WINDOWS_PRIVATE_ACL,
        encoding: "utf8",
        timeout: remaining,
        maxBuffer: 4096,
      },
    );
    const output = String(result.stdout || "")
      .trim()
      .split(/\r?\n/);
    let createdIdentity = null;
    if (stageRequest && output.length && output[0].startsWith("{")) {
      const receipt = JSON.parse(output.shift());
      if (
        !/^[0-9]{1,20}$/.test(receipt?.created?.dev) ||
        !/^[0-9]{1,20}$/.test(receipt?.created?.ino) ||
        BigInt(receipt.created.dev) > 0xffffffffffffffffn ||
        BigInt(receipt.created.ino) > 0xffffffffffffffffn ||
        BigInt(receipt.created.ino) === 0n
      )
        throw new Error("Invalid prompt creation receipt.");
      createdIdentity = receipt.created;
      // Do not adopt a path replacement even when it is owned by this user.
      try {
        const stat = fs.lstatSync(stageRequest.path, { bigint: true });
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1n &&
          stat.size === 0n &&
          String(stat.dev) === createdIdentity.dev &&
          String(stat.ino) === createdIdentity.ino
        )
          onCreate?.(stat);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (result.error || result.status !== 0 || output.join("\n") !== "private" || performance.now() > permissions.deadline)
      throw new Error("Private prompt ACL unavailable.");
    for (const item of pending) {
      const entry = exactStat(item.request.path);
      if (item.request.create && item.request.kind === "file") {
        if (!createdIdentity || String(entry.dev) !== createdIdentity.dev || String(entry.ino) !== createdIdentity.ino || entry.size !== 0n)
          throw new Error("Created prompt identity changed.");
      }
      if (
        (item.stat && !sameEntry(item.stat, entry)) ||
        entry.isSymbolicLink() ||
        (item.request.kind === "directory" ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1n)
      )
        throw new Error("Prompt ACL target changed.");
      item.identity = JSON.stringify([item.request.kind, String(entry.dev), String(entry.ino)]);
      if (item.request.create) item.createdEntry = entry;
    }
    // Batch success is all-or-nothing; never cache a partly verified request.
    for (const item of pending) permissions.checked.add(item.identity);
    return pending.find((item) => item.createdEntry)?.createdEntry;
  } catch (error) {
    permissions.failed = true;
    throw error;
  }
}

// stageFor (Windows only): also create the private stage for a later write of
// that file, in the same helper call, after the directory and existing file.
function privateDirectory(directory, permissions, existingFile = null, stageFor = null) {
  checkBudget(permissions);
  const stat = exactStat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())))
    throw new Error("Unsafe prompt directory.");
  if (process.platform !== "win32") return void fs.chmodSync(directory, 0o700);
  const stage = stageFor && !permissions.stage ? { path: stagePath(stageFor), file: stageFor, entry: null, used: false } : null;
  if (stage) permissions.stage = stage;
  windowsPrivate(
    [
      { path: directory, kind: "directory" },
      ...(existingFile ? [{ path: existingFile, kind: "file" }] : []),
      ...(stage ? [{ path: stage.path, kind: "file", create: true }] : []),
    ],
    permissions,
    stage
      ? (entry) => {
          stage.entry = entry;
        }
      : null,
  );
}

function sameEntry(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function privateFile(file, descriptor, permissions) {
  checkBudget(permissions);
  const stat = exactDescriptorStat(descriptor),
    entry = exactStat(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    entry.isSymbolicLink() ||
    !sameEntry(stat, entry) ||
    (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))
  )
    throw new Error("Unsafe prompt file.");
  if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
  else windowsPrivate([{ path: file, kind: "file" }], permissions);
  if (!sameEntry(stat, exactStat(file))) throw new Error("Prompt entry changed during permission check.");
  return stat;
}

function openPrivate(file) {
  const entry = exactStat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new Error("Unsafe prompt file.");
  // Nonblocking also prevents a replaced FIFO from hanging a lifecycle hook.
  return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
}

function readState(file, permissions, { withDigest = false } = {}) {
  if (!file) return null;
  let descriptor;
  try {
    privateDirectory(path.dirname(file), permissions);
    descriptor = openPrivate(file);
    const stat = privateFile(file, descriptor, permissions);
    if (stat.size > USER_PROMPT_REFERENCE_LIMITS.bytes) return null;
    const buffer = Buffer.alloc(USER_PROMPT_REFERENCE_LIMITS.bytes + 1);
    let used = 0,
      read;
    do {
      read = fs.readSync(descriptor, buffer, used, buffer.length - used, null);
      used += read;
    } while (read && used < buffer.length);
    if (used > USER_PROMPT_REFERENCE_LIMITS.bytes) return null;
    const state = parseState(buffer.subarray(0, used));
    return state && { ...state, ...(withDigest ? { byteDigest: sha256Hex(buffer.subarray(0, used)), entry: stat } : {}) };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseState(bytes) {
  const state = JSON.parse(bytes.toString("utf8"));
  if (state?.kind !== "UserPromptReference" || state.version !== 1 || !Array.isArray(state.prompts)) return null;
  // Existing references may predate current masks. Never inject their raw text.
  const prompts = state.prompts
    .slice(-USER_PROMPT_REFERENCE_LIMITS.prompts)
    .filter((prompt) => prompt && typeof prompt.text === "string")
    .map((prompt) => ({
      messageId: typeof prompt.messageId === "string" ? prompt.messageId.slice(0, 256) : null,
      text: boundText(prompt.text),
      ...(prompt.previousConversation === true ? { previousConversation: true } : {}),
      ...(typeof prompt.visibleResponse === "string" ? { visibleResponse: boundText(prompt.visibleResponse) } : {}),
    }))
    .filter((prompt) => prompt.text);
  return {
    prompts,
    reinject: state.reinject === true,
    ...(typeof state.visibleAssistant === "string" ? { visibleAssistant: boundText(state.visibleAssistant) } : {}),
    ...(state.visibleAssistantFromPreviousConversation === true ? { visibleAssistantFromPreviousConversation: true } : {}),
    revision: typeof state.revision === "string" ? state.revision : sha256Hex(bytes),
  };
}

// A guess only, read before the permission check: it decides whether the
// helper call also creates a stage, never what is written or returned. The
// operation reads the file again after verification and decides from that.
function peekState(file) {
  let descriptor;
  try {
    descriptor = openPrivate(file);
    const buffer = Buffer.alloc(USER_PROMPT_REFERENCE_LIMITS.bytes + 1);
    const used = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return used > USER_PROMPT_REFERENCE_LIMITS.bytes ? null : parseState(buffer.subarray(0, used));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function existingEntry(file, permissions) {
  let descriptor;
  try {
    descriptor = openPrivate(file);
    return privateFile(file, descriptor, permissions);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writePrivate(file, body, permissions, publication = null) {
  const directory = path.dirname(file);
  privateDirectory(directory, permissions);
  const original = existingEntry(file, permissions);
  if (publication?.createOnly && original) throw new Error("Prompt destination already exists.");
  // A stage this operation already created with the directory check (Windows)
  // is used once; every check below still runs on it before plaintext.
  const prepared = permissions.stage?.file === file && permissions.stage.entry && !permissions.stage.used ? permissions.stage : null;
  const temporary = prepared ? prepared.path : stagePath(file);
  let descriptor,
    owner,
    plaintextStarted = false;
  try {
    if (prepared) {
      prepared.used = true;
      owner = prepared.entry;
    } else if (process.platform === "win32")
      windowsPrivate([{ path: temporary, kind: "file", create: true }], permissions, (entry) => {
        owner = entry;
      });
    descriptor = fs.openSync(temporary, process.platform === "win32" ? "r+" : "wx", 0o600);
    if (owner && !sameEntry(owner, exactDescriptorStat(descriptor))) throw new Error("New private stage changed before open.");
    owner = exactDescriptorStat(descriptor); // Own the empty stage even if ACL verification fails.
    owner = privateFile(temporary, descriptor, permissions);
    const writable = exactDescriptorStat(descriptor);
    if (!sameEntry(owner, writable) || writable.size !== 0n) throw new Error("Private stage changed before plaintext write.");
    plaintextStarted = true;
    fs.writeFileSync(descriptor, body);
    fs.closeSync(descriptor);
    descriptor = undefined;
    privateDirectory(directory, permissions);
    const current = existingEntry(file, permissions);
    if (Boolean(original) !== Boolean(current) || (original && !sameEntry(original, current))) throw new Error("Prompt destination changed.");
    if (publication?.createOnly) {
      publication.commit(() => {
        checkBudget(permissions);
        // A same-directory link is atomic no-clobber publication. Remove only
        // this call's stage, leaving a single private destination link.
        fs.linkSync(temporary, file);
        publication.onCreate();
        fs.unlinkSync(temporary);
      });
      const published = existingEntry(file, permissions);
      if (!published || !sameEntry(owner, published)) throw new Error("Prompt publication changed.");
      return;
    }
    const delays = [5, 10, 20, 40];
    for (let attempt = 0; ; attempt += 1) {
      try {
        renamePath(temporary, file);
        break;
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
        privateDirectory(directory, permissions);
        const destination = existingEntry(file, permissions),
          stage = exactStat(temporary);
        if (
          !stage.isFile() ||
          stage.isSymbolicLink() ||
          !sameEntry(owner, stage) ||
          Boolean(current) !== Boolean(destination) ||
          (current && (!sameEntry(current, destination) || current.size !== destination.size || current.mtimeMs !== destination.mtimeMs))
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      }
    }
    const published = existingEntry(file, permissions);
    if (!published || !sameEntry(owner, published)) throw new Error("Prompt publication changed.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      const entry = exactStat(temporary);
      if (owner && entry.isFile() && !entry.isSymbolicLink() && sameEntry(owner, entry) && (plaintextStarted || entry.size === 0n)) fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeState(file, state, permissions, publication = null) {
  let prompts = state.prompts.slice(-USER_PROMPT_REFERENCE_LIMITS.prompts);
  if (!prompts.length && state.reinject !== true) {
    privateDirectory(path.dirname(file), permissions);
    if (existingEntry(file, permissions)) fs.unlinkSync(file);
    return;
  }
  let body = "";
  do {
    body =
      JSON.stringify({
        kind: "UserPromptReference",
        version: 1,
        authorityPlane: "P5",
        recoveryAuthority: false,
        instructionAuthority: false,
        revision: crypto.randomUUID(),
        reinject: state.reinject === true,
        prompts,
        ...(state.visibleAssistant ? { visibleAssistant: state.visibleAssistant } : {}),
        ...(state.visibleAssistantFromPreviousConversation === true ? { visibleAssistantFromPreviousConversation: true } : {}),
      }) + "\n";
    if (Buffer.byteLength(body) <= USER_PROMPT_REFERENCE_LIMITS.bytes) break;
    prompts = prompts.slice(1);
  } while (prompts.length);
  if (!prompts.length && state.reinject !== true) return;
  writePrivate(file, body, permissions, publication);
}

export function captureUserPrompt({ root, runtime, nativeSessionId, agentId = null, text, messageId = null, environment = process.env } = {}) {
  const next = boundText(typeof text === "string" ? text : "");
  messageId = typeof messageId === "string" && messageId.length <= 256 ? messageId : null;
  if (!next) return { captured: false };
  let file;
  const permissions = privatePermissions();
  try {
    try {
      file = callerFile(root, runtime, nativeSessionId, agentId, environment, true, permissions, () => true);
    } catch {
      return { captured: false };
    }
    if (!file) return { captured: false };
    try {
      return mutateReference(permissions, () => {
        const state = readState(file, permissions) || { prompts: [], reinject: false };
        // A freeze holds the pre-compaction text. Later synthetic turns cannot replace it.
        if (state.reinject === true) return { captured: false, frozen: true };
        const last = state.prompts.at(-1);
        if (messageId && last?.messageId === messageId && !last.previousConversation) {
          last.text =
            last.text.includes(next) && next.length <= last.text.length ? last.text : boundText(last.text.includes(next) ? next : last.text + "\n" + next);
        } else {
          state.prompts.push({ messageId: messageId || null, text: next });
        }
        writeState(file, state, permissions);
        return { captured: true };
      });
    } catch {
      return { captured: false };
    }
  } finally {
    discardStage(permissions);
  }
}

export function freezeUserPromptReference({ root, runtime, nativeSessionId, agentId = null, environment = process.env } = {}) {
  let file;
  const permissions = privatePermissions();
  try {
    try {
      file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions, (existing) => Boolean(existing));
    } catch {
      return { frozen: false };
    }
    if (!file) return { frozen: false };
    try {
      return mutateReference(permissions, () => {
        const state = readState(file, permissions);
        if (!state?.prompts?.length) return { frozen: false };
        state.reinject = true;
        writeState(file, state, permissions);
        return { frozen: true };
      });
    } catch {
      return { frozen: false };
    }
  } finally {
    discardStage(permissions);
  }
}

// Only the command Host's direct Stop field is supported. Never inspect a
// transcript, reasoning, tools, StopFailure error text or OpenCode event order.
// A Codex turn ID can identify its own response; neither Host contract proves
// that a later short user reply refers to this proposal.
export function captureVisibleAssistantReference({ root, runtime, nativeSessionId, agentId = null, environment = process.env, text, turnId = null } = {}) {
  if (!["codex", "claude"].includes(runtime)) return { captured: false, reason: "unsupported-host-contract" };
  const permissions = privatePermissions();
  const next = boundText(typeof text === "string" ? text : "");
  try {
    const file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions, (existing) => {
      const peeked = existing && peekState(existing);
      return Boolean(peeked && visibleAssistantChange(peeked, runtime, next, turnId) === null);
    });
    if (!file) return { captured: false };
    return mutateReference(permissions, () => {
      const state = readState(file, permissions);
      const unchanged = visibleAssistantChange(state, runtime, next, turnId);
      if (unchanged) return unchanged;
      writeState(file, state, permissions);
      return { captured: Boolean(next), adjacency: "unverified", authorityChanged: false };
    });
  } catch {
    return { captured: false };
  } finally {
    discardStage(permissions);
  }
}

// Applies the visible assistant text to state and returns null when the
// reference must be written, or the result to return without a write.
function visibleAssistantChange(state, runtime, next, turnId) {
  if (!state?.prompts.length || state.reinject) return { captured: false };
  if (runtime === "codex") {
    const last = state.prompts.at(-1);
    if (typeof turnId !== "string" || last.messageId !== turnId) return { captured: false, reason: "unverified-turn" };
    if ((last.visibleResponse || "") === next) return { captured: false, reused: true };
    if (next) last.visibleResponse = next;
    else delete last.visibleResponse;
  } else {
    if ((state.visibleAssistant || "") === next && !state.visibleAssistantFromPreviousConversation) return { captured: false, reused: true };
    if (next) state.visibleAssistant = next;
    else delete state.visibleAssistant;
    delete state.visibleAssistantFromPreviousConversation;
  }
  return null;
}

function mutateReference(permissions, operation) {
  checkBudget(permissions);
  return withLocalMutation({ directory: permissions.lock, timeoutMs: Math.max(0, Math.min(5000, permissions.deadline - performance.now())) }, () => {
    checkBudget(permissions);
    return operation();
  });
}

// Trusted paired-clear composition only. Raw old-caller arguments cannot select
// a source: the clear verifier owns the one-use proof and commit validation.
export function transferNativeClearPromptReference({ handoff, root, caller, environment = process.env, deadlineAt, operation } = {}) {
  const { withVerifiedClearPromptTransfer } = require("./session-clear-handoff.mjs");
  return withVerifiedClearPromptTransfer({ handoff, root, caller, environment, deadlineAt }, (scope) => {
    let created = false;
    try {
      const permissions = operationPermissions(operation),
        old = scope.oldCaller,
        next = scope.nextCaller;
      const sourceFile = callerFile(scope.root, old.runtime, old.nativeSessionId, old.agentId, environment, false, permissions);
      if (!sourceFile) return { transferred: false, reasonCode: "CLEAR_REFERENCE_MISSING" };
      const sourceLock = permissions.lock;
      const destination = callerFile(scope.root, next.runtime, next.nativeSessionId, next.agentId, environment, true, permissions);
      const locks = [...new Set([sourceLock, permissions.lock])].sort();
      if (!destination || destination === sourceFile) return { transferred: false, reasonCode: "CLEAR_REFERENCE_UNAVAILABLE" };
      const locked = (index) =>
        index === locks.length
          ? copy()
          : withLocalMutation({ directory: locks[index], timeoutMs: Math.max(0, Math.min(5000, permissions.deadline - performance.now())) }, () => {
              checkBudget(permissions);
              return locked(index + 1);
            });
      const copy = () => {
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) return { transferred: false, reasonCode: "CLEAR_REFERENCE_DESTINATION_EXISTS" };
        const source = readState(sourceFile, permissions, { withDigest: true });
        if (!source?.prompts.length) return { transferred: false, reasonCode: "CLEAR_REFERENCE_MISSING" };
        const directory = exactStat(path.dirname(sourceFile));
        const state = {
          prompts: source.prompts.map((prompt) => ({ ...prompt, previousConversation: true })),
          reinject: false,
          ...(source.visibleAssistant ? { visibleAssistant: source.visibleAssistant, visibleAssistantFromPreviousConversation: true } : {}),
        };
        writeState(destination, state, permissions, {
          createOnly: true,
          onCreate() {
            created = true;
          },
          commit: (publish) =>
            scope.commit(() => {
              checkBudget(permissions);
              if (
                !sameEntry(directory, exactStat(path.dirname(sourceFile))) ||
                !sameEntry(source.entry, exactStat(sourceFile)) ||
                fs.lstatSync(destination, { throwIfNoEntry: false })
              )
                throw new Error("Prompt transfer source/destination changed.");
              const current = readState(sourceFile, permissions, { withDigest: true });
              if (!current || current.revision !== source.revision || current.byteDigest !== source.byteDigest)
                throw new Error("Prompt transfer generation changed.");
              publish();
            }),
        });
        return { transferred: true, created: true, conversationOrigin: "previous-native-conversation", ordinaryWorkBlocked: false };
      };
      return locked(0);
    } catch {
      return { transferred: false, created, reasonCode: created ? "CLEAR_REFERENCE_CREATED_UNCONFIRMED" : "CLEAR_REFERENCE_UNAVAILABLE" };
    }
  });
}

// Preparation never consumes. The whole bounded reference is included or left
// intact; limits count UTF-16 characters, as do the Host context renderers.
export function prepareUserPromptReference({
  root,
  runtime,
  nativeSessionId,
  agentId = null,
  environment = process.env,
  force = false,
  additionalContext = "",
  limit = Infinity,
  operation,
} = {}) {
  let file, permissions;
  try {
    permissions = operationPermissions(operation);
    file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions);
  } catch {
    return null;
  }
  const state = readState(file, permissions);
  // Compact and clear pass force so a host without PreCompact still restores.
  // Ordinary requests leave an unfrozen reference in place.
  if (!state?.prompts?.length || (!state.reinject && force !== true)) return null;
  const lines = state.prompts.map(
    (prompt, index) =>
      index +
      1 +
      ". " +
      JSON.stringify({
        hostDeliveredPrompt: prompt.text,
        humanOrigin: "unverified",
        ...(prompt.previousConversation
          ? { conversationOrigin: "previous-native-conversation", originalMessageId: prompt.messageId, approval: "not-inferred" }
          : {}),
        ...(prompt.visibleResponse
          ? {
              visibleFinalResponse: prompt.visibleResponse,
              source: "Stop.last_assistant_message",
              ...(prompt.previousConversation ? { originalTurnId: prompt.messageId } : { turnId: prompt.messageId }),
              adjacencyToLaterUserReply: "unverified",
              approval: "not-inferred",
            }
          : {}),
      }),
  );
  if (state.visibleAssistant)
    lines.push(
      JSON.stringify({
        visibleFinalResponse: state.visibleAssistant,
        ...(state.visibleAssistantFromPreviousConversation ? { conversationOrigin: "previous-native-conversation" } : {}),
        source: "Stop.last_assistant_message",
        adjacencyToUserReply: "unverified",
        approval: "not-inferred",
      }),
    );
  const text = LABEL + "\n" + lines.join("\n");
  if (
    typeof additionalContext !== "string" ||
    typeof limit !== "number" ||
    Number.isNaN(limit) ||
    limit < 0 ||
    additionalContext.length + 2 + text.length > limit
  )
    return null;
  const preparation = Object.freeze({ text });
  preparations.set(preparation, {
    root,
    runtime,
    nativeSessionId,
    agentId,
    environment,
    file,
    revision: state.revision,
    ...(operation ? { permissions } : {}),
  });
  return preparation;
}

// A local sink/slot accepted the prepared output. This is not Host/model
// acknowledgement. An interrupted acknowledgement may repeat a hint, never an
// action. A changed generation is preserved in full, including newer captures.
export function acknowledgeUserPromptReference(preparation) {
  const saved = preparation && preparations.get(preparation);
  if (!saved) return false;
  preparations.delete(preparation);
  const permissions = saved.permissions || privatePermissions();
  try {
    const file = callerFile(saved.root, saved.runtime, saved.nativeSessionId, saved.agentId, saved.environment, false, permissions);
    if (!file || file !== saved.file) return false;
    return mutateReference(permissions, () => {
      const state = readState(file, permissions);
      if (!state || state.revision !== saved.revision) return false;
      writeState(file, { prompts: [], reinject: false }, permissions);
      return true;
    });
  } catch {
    return false;
  }
}

// Explicit synchronous take remains available to direct callers. Host delivery
// must use prepare/acknowledge so output failure cannot consume unseen text.
export function takeUserPromptReference(options = {}) {
  const prepared = prepareUserPromptReference(options);
  return prepared && acknowledgeUserPromptReference(prepared) ? prepared.text : "";
}

export function appendUserPromptReference(additionalContext, reference, limit) {
  if (typeof additionalContext !== "string" || typeof reference !== "string" || !reference) return additionalContext;
  const next = additionalContext + "\n\n" + reference;
  return next.length <= limit ? next : additionalContext;
}
