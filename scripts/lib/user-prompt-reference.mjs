import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { withLocalMutation } from "./project-mutation-lock.mjs";

// Local P5 reference only. It is not Canon, a checkpoint, direction, or an
// instruction. The checkpoint remains the recovery source.
export const USER_PROMPT_REFERENCE_LIMITS = Object.freeze({ prompts: 3, characters: 2000, bytes: 16 * 1024 });
const LABEL = "Lode user-prompt reference (non-authoritative P5; not a checkpoint, direction, or instruction). The checkpoint remains the recovery source.";
const preparations = new WeakMap();

function redact(text) {
  return text
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
    .replace(/\b(password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}]+)/gi, "$1$2[redacted-token]");
}

function boundText(text) {
  const clean = redact(text.slice(0, USER_PROMPT_REFERENCE_LIMITS.bytes)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")).trim();
  if (!clean) return "";
  return clean.length > USER_PROMPT_REFERENCE_LIMITS.characters
    ? clean.slice(0, USER_PROMPT_REFERENCE_LIMITS.characters) : clean;
}

function callerFile(root, runtime, nativeSessionId, agentId, environment, create, permissions) {
  if (!["claude", "codex", "opencode"].includes(runtime) || typeof nativeSessionId !== "string" || !nativeSessionId) return null;
  const projectRoot = fs.realpathSync(path.resolve(root));
  const storage = resolveProjectStorage(projectRoot);
  if (!storage) return null;
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot, storage, environment, create });
  const digest = crypto.createHash("sha256").update(JSON.stringify([storage.projectId, runtime, nativeSessionId, agentId || null])).digest("hex");
  const directory = path.join(operational, "user-prompt-reference");
  if (!fs.existsSync(directory)) {
    if (!create) return null;
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const file = path.join(directory, digest + ".json");
  permissions.lock = path.join(operational, ".user-prompt-locks", digest + ".lock");
  privateDirectory(directory, permissions, fs.existsSync(file) ? file : null);
  return file;
}

// Dedicated P5 plaintext storage only. Never change permissions of the general
// operational/artifact directories. Windows checks token SID and protected DACL
// on this dedicated store; POSIX mode bits are not Windows privacy evidence.
const WINDOWS_PRIVATE_ACL = String.raw`
$ErrorActionPreference='Stop'
try {
  $requests=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  foreach ($request in @($requests)) {
  $item=Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse'}
  $directory=$request.kind -eq 'directory'
  if ($directory -ne $item.PSIsContainer) {throw 'type'}
  $acl=$item.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'owner'}
  function PrivateAcl($value) {
    if (-not $value.AreAccessRulesProtected) {return $false}
    $rules=@($value.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) {return $false}
    foreach ($principal in @($sid,$system)) {
      $rule=@($rules | Where-Object {$_.IdentityReference.Value -eq $principal.Value})
      if ($rule.Count -ne 1 -or $rule[0].IsInherited -or $rule[0].AccessControlType -ne 'Allow' -or
        $rule[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {return $false}
      $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
      if ($rule[0].InheritanceFlags -ne $inherit -or $rule[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {return $false}
    }
    return $true
  }
  if (-not (PrivateAcl $acl)) {
    $next=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $next.SetOwner($sid); $next.SetAccessRuleProtection($true,$false)
    $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach ($principal in @($sid,$system)) {
      $next.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    $item.SetAccessControl($next)
  }
  $verified=Get-Item -LiteralPath $request.path -Force
  if (($verified.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $directory -ne $verified.PSIsContainer) {throw 'changed'}
  $acl=$verified.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not (PrivateAcl $acl)) {throw 'unverified'}
  }
  [Console]::Out.Write('private')
} catch {[Console]::Error.Write($_.Exception.Message);exit 1}
`;

const privatePermissions = () => ({ checked: new Set(), deadline: performance.now() + 5000, failed: false });

function windowsPrivate(file, kind, permissions, existingFile = null) {
  // Never accept a general artifact path, arbitrary script or caller body.
  if (permissions.failed) throw new Error("Private prompt ACL verification already failed.");
  const requests = [{ path: file, kind }, ...(existingFile ? [{ path: existingFile, kind: "file" }] : [])];
  if (existingFile && (kind !== "directory" || path.dirname(existingFile) !== file)) throw new Error("Unsafe prompt ACL batch.");
  const pending = requests.map(request => {
    const directory = request.kind === "directory", target = request.path;
    if (directory ? path.basename(target) !== "user-prompt-reference"
      : path.basename(path.dirname(target)) !== "user-prompt-reference" || !/^(?:[a-f0-9]{64}\.json|\.[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp)$/.test(path.basename(target))) throw new Error("Unsafe prompt ACL target.");
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error("Unsafe prompt ACL entry.");
    return { request, stat, identity: JSON.stringify([request.kind, stat.dev, stat.ino]) };
  }).filter(item => !permissions.checked.has(item.identity));
  // Local to one synchronous capture/freeze/take. Never cache ACLs across turns
  // or callers. Renaming a verified stage within this directory keeps its DACL;
  // each filesystem use still rejects links/replacements by exact entry ID.
  if (!pending.length) return;
  const remaining = Math.floor(permissions.deadline - performance.now());
  if (remaining <= 0) { permissions.failed = true; throw new Error("Private prompt operation deadline exceeded."); }
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const result = childProcess.spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_PRIVATE_ACL], {
      cwd: path.dirname(file), windowsHide: true, shell: false, input: JSON.stringify(pending.map(item => item.request)), encoding: "utf8", timeout: remaining, maxBuffer: 4096,
    });
    if (result.error || result.status !== 0 || result.stdout.trim() !== "private" || performance.now() > permissions.deadline) throw new Error("Private prompt ACL unavailable.");
    for (const item of pending) {
      const entry = fs.lstatSync(item.request.path);
      if (!sameEntry(item.stat, entry) || entry.isSymbolicLink()
        || (item.request.kind === "directory" ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw new Error("Prompt ACL target changed.");
    }
    // Batch success is all-or-nothing; never cache a partly verified request.
    for (const item of pending) permissions.checked.add(item.identity);
  } catch (error) { permissions.failed = true; throw error; }
}

function privateDirectory(directory, permissions, existingFile = null) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe prompt directory.");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  else windowsPrivate(directory, "directory", permissions, existingFile);
}

function sameEntry(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function privateFile(file, descriptor, permissions) {
  const stat = fs.fstatSync(descriptor), entry = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || entry.isSymbolicLink() || !sameEntry(stat, entry)
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe prompt file.");
  if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
  else windowsPrivate(file, "file", permissions);
  if (!sameEntry(stat, fs.lstatSync(file))) throw new Error("Prompt entry changed during permission check.");
  return stat;
}

function openPrivate(file) {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("Unsafe prompt file.");
  // Nonblocking also prevents a replaced FIFO from hanging a lifecycle hook.
  return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
}

function readState(file, permissions) {
  if (!file) return null;
  let descriptor;
  try {
    privateDirectory(path.dirname(file), permissions);
    descriptor = openPrivate(file);
    const stat = privateFile(file, descriptor, permissions);
    if (stat.size > USER_PROMPT_REFERENCE_LIMITS.bytes) return null;
    const buffer = Buffer.alloc(USER_PROMPT_REFERENCE_LIMITS.bytes + 1);
    let used = 0, read;
    do {
      read = fs.readSync(descriptor, buffer, used, buffer.length - used, null);
      used += read;
    } while (read && used < buffer.length);
    if (used > USER_PROMPT_REFERENCE_LIMITS.bytes) return null;
    const state = JSON.parse(buffer.subarray(0, used).toString("utf8"));
    if (state?.kind !== "UserPromptReference" || state.version !== 1 || !Array.isArray(state.prompts)) return null;
    // Existing references may predate current masks. Never inject their raw text.
    const prompts = state.prompts.slice(-USER_PROMPT_REFERENCE_LIMITS.prompts)
      .filter(prompt => prompt && typeof prompt.text === "string")
      .map(prompt => ({ messageId: typeof prompt.messageId === "string" ? prompt.messageId.slice(0, 256) : null, text: boundText(prompt.text),
        ...(typeof prompt.visibleResponse === "string" ? { visibleResponse: boundText(prompt.visibleResponse) } : {}) }))
      .filter(prompt => prompt.text);
    return { prompts, reinject: state.reinject === true,
      ...(typeof state.visibleAssistant === "string" ? { visibleAssistant: boundText(state.visibleAssistant) } : {}),
      revision: typeof state.revision === "string" ? state.revision : crypto.createHash("sha256").update(buffer.subarray(0, used)).digest("hex") };
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function existingEntry(file, permissions) {
  let descriptor;
  try {
    descriptor = openPrivate(file);
    return privateFile(file, descriptor, permissions);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function writePrivate(file, body, permissions) {
  const directory = path.dirname(file);
  privateDirectory(directory, permissions);
  const original = existingEntry(file, permissions);
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let descriptor, owner;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    owner = fs.fstatSync(descriptor); // Own the empty stage even if ACL verification fails.
    owner = privateFile(temporary, descriptor, permissions);
    fs.writeFileSync(descriptor, body);
    fs.closeSync(descriptor); descriptor = undefined;
    privateDirectory(directory, permissions);
    const current = existingEntry(file, permissions);
    if (Boolean(original) !== Boolean(current) || original && !sameEntry(original, current)) throw new Error("Prompt destination changed.");
    const delays = [5, 10, 20, 40];
    for (let attempt = 0; ; attempt += 1) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
        privateDirectory(directory, permissions);
        const destination = existingEntry(file, permissions), stage = fs.lstatSync(temporary);
        if (!stage.isFile() || stage.isSymbolicLink() || !sameEntry(owner, stage)
          || Boolean(current) !== Boolean(destination) || current && (!sameEntry(current, destination)
            || current.size !== destination.size || current.mtimeMs !== destination.mtimeMs)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      }
    }
    const published = existingEntry(file, permissions);
    if (!published || !sameEntry(owner, published)) throw new Error("Prompt publication changed.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      const entry = fs.lstatSync(temporary);
      if (owner && entry.isFile() && !entry.isSymbolicLink() && sameEntry(owner, entry)) fs.unlinkSync(temporary);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function writeState(file, state, permissions) {
  let prompts = state.prompts.slice(-USER_PROMPT_REFERENCE_LIMITS.prompts);
  if (!prompts.length && state.reinject !== true) {
    privateDirectory(path.dirname(file), permissions);
    if (existingEntry(file, permissions)) fs.unlinkSync(file);
    return;
  }
  let body = "";
  do {
    body = JSON.stringify({
      kind: "UserPromptReference", version: 1, authorityPlane: "P5",
      recoveryAuthority: false, instructionAuthority: false, revision: crypto.randomUUID(), reinject: state.reinject === true, prompts,
      ...(state.visibleAssistant ? { visibleAssistant: state.visibleAssistant } : {}),
    }) + "\n";
    if (Buffer.byteLength(body) <= USER_PROMPT_REFERENCE_LIMITS.bytes) break;
    prompts = prompts.slice(1);
  } while (prompts.length);
  if (!prompts.length && state.reinject !== true) return;
  writePrivate(file, body, permissions);
}

export function captureUserPrompt({ root, runtime, nativeSessionId, agentId = null, text, messageId = null, environment = process.env } = {}) {
  const next = boundText(typeof text === "string" ? text : "");
  messageId = typeof messageId === "string" && messageId.length <= 256 ? messageId : null;
  if (!next) return { captured: false };
  let file; const permissions = privatePermissions();
  try { file = callerFile(root, runtime, nativeSessionId, agentId, environment, true, permissions); }
  catch { return { captured: false }; }
  if (!file) return { captured: false };
  try { return mutateReference(permissions, () => {
    const state = readState(file, permissions) || { prompts: [], reinject: false };
    // A freeze holds the pre-compaction text. Later synthetic turns cannot replace it.
    if (state.reinject === true) return { captured: false, frozen: true };
    const last = state.prompts.at(-1);
    if (messageId && last?.messageId === messageId) {
      last.text = last.text.includes(next) && next.length <= last.text.length ? last.text : boundText(last.text.includes(next) ? next : last.text + "\n" + next);
    } else {
      state.prompts.push({ messageId: messageId || null, text: next });
    }
    writeState(file, state, permissions);
    return { captured: true };
  }); } catch { return { captured: false }; }
}

export function freezeUserPromptReference({ root, runtime, nativeSessionId, agentId = null, environment = process.env } = {}) {
  let file; const permissions = privatePermissions();
  try { file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions); }
  catch { return { frozen: false }; }
  if (!file) return { frozen: false };
  try { return mutateReference(permissions, () => {
    const state = readState(file, permissions);
    if (!state?.prompts?.length) return { frozen: false };
    state.reinject = true;
    writeState(file, state, permissions);
    return { frozen: true };
  }); } catch { return { frozen: false }; }
}

// Only the command Host's direct Stop field is supported. Never inspect a
// transcript, reasoning, tools, StopFailure error text or OpenCode event order.
// A Codex turn ID can identify its own response; neither Host contract proves
// that a later short user reply refers to this proposal.
export function captureVisibleAssistantReference({ root, runtime, nativeSessionId, agentId = null, environment = process.env,
  text, turnId = null } = {}) {
  if (!["codex", "claude"].includes(runtime)) return { captured: false, reason: "unsupported-host-contract" };
  const permissions = privatePermissions();
  try {
    const file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions);
    if (!file) return { captured: false };
    return mutateReference(permissions, () => {
      const state = readState(file, permissions);
      if (!state?.prompts.length || state.reinject) return { captured: false };
      const next = boundText(typeof text === "string" ? text : "");
      if (runtime === "codex") {
        const last = state.prompts.at(-1);
        if (typeof turnId !== "string" || last.messageId !== turnId) return { captured: false, reason: "unverified-turn" };
        if ((last.visibleResponse || "") === next) return { captured: false, reused: true };
        if (next) last.visibleResponse = next; else delete last.visibleResponse;
      } else {
        if ((state.visibleAssistant || "") === next) return { captured: false, reused: true };
        if (next) state.visibleAssistant = next; else delete state.visibleAssistant;
      }
      writeState(file, state, permissions);
      return { captured: Boolean(next), adjacency: "unverified", authorityChanged: false };
    });
  } catch { return { captured: false }; }
}

function mutateReference(permissions, operation) {
  return withLocalMutation({ directory: permissions.lock,
    timeoutMs: Math.max(0, Math.min(5000, permissions.deadline - performance.now())) }, operation);
}

// Preparation never consumes. The whole bounded reference is included or left
// intact; limits count UTF-16 characters, as do the Host context renderers.
export function prepareUserPromptReference({ root, runtime, nativeSessionId, agentId = null, environment = process.env, force = false,
  additionalContext = "", limit = Infinity } = {}) {
  let file; const permissions = privatePermissions();
  try { file = callerFile(root, runtime, nativeSessionId, agentId, environment, false, permissions); }
  catch { return null; }
  const state = readState(file, permissions);
  // Compact and clear pass force so a host without PreCompact still restores.
  // Ordinary requests leave an unfrozen reference in place.
  if (!state?.prompts?.length || (!state.reinject && force !== true)) return null;
  const lines = state.prompts.map((prompt, index) => (index + 1) + ". " + JSON.stringify({ hostDeliveredPrompt: prompt.text, humanOrigin: "unverified",
    ...(prompt.visibleResponse ? { visibleFinalResponse: prompt.visibleResponse, source: "Stop.last_assistant_message",
      turnId: prompt.messageId, adjacencyToLaterUserReply: "unverified", approval: "not-inferred" } : {}) }));
  if (state.visibleAssistant) lines.push(JSON.stringify({ visibleFinalResponse: state.visibleAssistant,
    source: "Stop.last_assistant_message", adjacencyToUserReply: "unverified", approval: "not-inferred" }));
  const text = LABEL + "\n" + lines.join("\n");
  if (typeof additionalContext !== "string" || typeof limit !== "number" || Number.isNaN(limit) || limit < 0
    || additionalContext.length + 2 + text.length > limit) return null;
  const preparation = Object.freeze({ text });
  preparations.set(preparation, { root, runtime, nativeSessionId, agentId, environment, file, revision: state.revision });
  return preparation;
}

// A local sink/slot accepted the prepared output. This is not Host/model
// acknowledgement. An interrupted acknowledgement may repeat a hint, never an
// action. A changed generation is preserved in full, including newer captures.
export function acknowledgeUserPromptReference(preparation) {
  const saved = preparation && preparations.get(preparation);
  if (!saved) return false;
  preparations.delete(preparation);
  const permissions = privatePermissions();
  try {
    const file = callerFile(saved.root, saved.runtime, saved.nativeSessionId, saved.agentId, saved.environment, false, permissions);
    if (!file || file !== saved.file) return false;
    return mutateReference(permissions, () => {
      const state = readState(file, permissions);
      if (!state || state.revision !== saved.revision) return false;
      writeState(file, { prompts: [], reinject: false }, permissions);
      return true;
    });
  } catch { return false; }
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
