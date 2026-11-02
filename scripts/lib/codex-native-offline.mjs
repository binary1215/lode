import { BoundedVersionWorkspaceHostAdapter } from "./runtime-machine-execution.mjs";
import { codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { copiedProjectFile } from "./project-copy-evidence.mjs";

const witnesses = new WeakMap(),
  children = new Map();
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = (stat) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
export const codexNativeOfflineProcessStatus = () =>
  [...children.values()].map((value) => ({ ...value }));

// Query-only process inventory. No home, DB, account, model or process command
// line is read. Without a trustworthy home attribution, any live Codex engine
// is conservatively unresolved for native-only offline publication. The user
// closes their application during an explicit offline window; we never kill it.
export async function observeCodexNativeWriters({
  signal,
  onProcess = () => {},
  timeoutMs = 10000,
} = {}) {
  if (process.platform !== "win32") return { status: "unsupported-platform", rows: [] };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    fail("NATIVE_CODEX_OBSERVER_LIMIT_INVALID");
  if (signal?.aborted) fail("NATIVE_CODEX_OFFLINE_CANCELLED");
  const script = `$ErrorActionPreference='Stop'
$taskRows=@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {
  @{pid=[long]$_.ProcessId;parentPid=[long]$_.ParentProcessId;birth=$_.CreationDate.ToUniversalTime().ToString('o');home='unresolved'}
})
@{status='observed';rows=@($taskRows)} | ConvertTo-Json -Depth 4 -Compress
`;
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
  ];
  const record = (value) => {
    try {
      onProcess({ ...value, ports: [], windowsHide: true });
    } catch {
      /* Observation does not control another process. */
    }
  };
  record({ event: "planned", command: executable, args, parentPid: process.pid });
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(
        ["SystemRoot", "WINDIR", "TEMP", "TMP"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
    });
    let failure = null,
      size = 0;
    const chunks = [];
    const stop = (code) => {
      failure ??= Object.assign(new Error(code), { code });
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const abort = () => stop("NATIVE_CODEX_OFFLINE_CANCELLED"),
      timer = setTimeout(() => stop("NATIVE_CODEX_OBSERVER_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        size += bytes.length;
        if (size > 65536) stop("NATIVE_CODEX_OBSERVER_OUTPUT_LIMIT");
        else if (stream === child.stdout) chunks.push(Buffer.from(bytes));
      });
    child.once("close", (code, processSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (child.pid) children.delete(child.pid);
      record({
        event: "closed",
        pid: child.pid,
        parentPid: process.pid,
        exitCode: code,
        signal: processSignal,
      });
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        resolve({ status: "unknown", rows: [] });
        return;
      }
      try {
        const value = JSON.parse(
          Buffer.concat(chunks)
            .toString("utf8")
            .replace(/^\uFEFF/, ""),
        );
        if (
          value.status !== "observed" ||
          !Array.isArray(value.rows) ||
          value.rows.some(
            (row) =>
              !Number.isSafeInteger(row.pid) ||
              row.pid < 1 ||
              !Number.isSafeInteger(row.parentPid) ||
              row.parentPid < 0 ||
              typeof row.birth !== "string" ||
              !row.birth ||
              row.home !== "unresolved",
          )
        )
          fail("NATIVE_CODEX_OBSERVER_INVALID");
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    if (child.pid) {
      const value = {
        pid: child.pid,
        parentPid: process.pid,
        command: executable,
        args,
        ports: [],
        startedAt: new Date().toISOString(),
      };
      children.set(child.pid, value);
      record({ event: "started", ...value });
    }
    if (signal?.aborted) abort();
    try {
      child.stdin.end(script + "\n\n");
    } catch (error) {
      failure ??= error;
      stop("NATIVE_CODEX_OBSERVER_FAILED");
    }
  });
}

function homeBasis(home) {
  const resolved = path.resolve(home),
    canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) fail("NATIVE_CODEX_HOME_ALIAS");
  // Check every component, including an existing junction above the data-home.
  const volume = path.parse(canonical).root;
  copiedProjectFile(volume, path.relative(volume, canonical).replaceAll("\\", "/"));
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory()) fail("NATIVE_CODEX_HOME_INVALID");
  return { root: canonical, identity: [stat.dev, stat.ino].map(String).join(":") };
}
function executableBasis(executable) {
  const resolved = path.resolve(executable);
  if (fs.realpathSync(resolved) !== resolved || !/^codex\.exe$/i.test(path.basename(resolved)))
    fail("NATIVE_CODEX_EXECUTABLE_INVALID");
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    fail("NATIVE_CODEX_EXECUTABLE_INVALID");
  return { path: resolved, identity: identity(stat) };
}
function validateObservation(value) {
  if (value?.status !== "observed" || !Array.isArray(value.rows)) return false;
  if (
    value.rows.some(
      (row) =>
        !Number.isSafeInteger(row.pid) ||
        row.pid < 1 ||
        typeof row.birth !== "string" ||
        !row.birth,
    )
  )
    fail("NATIVE_CODEX_OBSERVER_INVALID");
  return true;
}
// probe is an internal Host/test seam, never a JSON flag, PID list or saved
// writers-stopped marker. A positive result yields an opaque same-process
// witness which must be re-observed at every dependent publication boundary.
export async function observeCodexNativeVersion({ executable, onProcess = () => {} }) {
  const report = (event) => {
    try {
      onProcess({ ...event, ports: [], windowsHide: true });
    } catch {}
  };
  const adapter = new BoundedVersionWorkspaceHostAdapter({
    spawnImplementation(command, args, options) {
      report({ event: "planned", command, args, parentPid: process.pid });
      const child = spawn(command, args, options);
      child.once("close", (code, signal) => {
        if (child.pid) children.delete(child.pid);
        report({ event: "closed", pid: child.pid, parentPid: process.pid, exitCode: code, signal });
      });
      if (child.pid) {
        const record = {
          pid: child.pid,
          parentPid: process.pid,
          command,
          args,
          ports: [],
          startedAt: new Date().toISOString(),
        };
        children.set(child.pid, record);
        report({ event: "started", ...record });
      }
      return child;
    },
  });
  return adapter.executeVersionProbe({
    executablePath: executable,
    cwd: path.parse(executable).root,
    environment: process.env,
  });
}

export async function prepareCodexNativeOffline({
  home,
  executable,
  signal,
  onProcess,
  probe = observeCodexNativeWriters,
  versionProbe = observeCodexNativeVersion,
} = {}) {
  if (typeof probe !== "function" || typeof versionProbe !== "function")
    fail("NATIVE_CODEX_OBSERVER_INVALID");
  const basis = homeBasis(home),
    engine = executableBasis(executable);
  const observation = await probe({ signal, onProcess });
  if (!validateObservation(observation) || observation.rows.length)
    return {
      status:
        observation?.status === "observed"
          ? "writers-present-or-home-unresolved"
          : "writer-state-unknown",
      nativePublicationReady: false,
      ordinaryCoreBlocked: false,
      stopsProcesses: false,
      witness: null,
    };
  const version = await versionProbe({ executable: engine.path, onProcess });
  const expected = codexNativePortabilityProfile();
  if (version?.status !== "verified" || version.version !== expected.engineVersion)
    fail("NATIVE_CODEX_PROFILE_UNSUPPORTED");
  if (identity(fs.lstatSync(engine.path, { bigint: true })) !== engine.identity)
    fail("NATIVE_CODEX_OFFLINE_BASIS_CHANGED");
  const afterVersion = await probe({ signal, onProcess });
  if (!validateObservation(afterVersion) || afterVersion.rows.length)
    fail("NATIVE_CODEX_WRITER_STATE_UNCERTAIN");
  const witness = Object.freeze(Object.create(null));
  witnesses.set(witness, { basis, engine, probe, engineVersion: version.version });
  return {
    status: "stopped-at-check",
    offlineWindowObserved: true,
    nativePublicationReady: false,
    ordinaryCoreBlocked: false,
    stopsProcesses: false,
    witness,
    targetHomeDigest: hash(basis.root),
    observationScope: "query-only-all-Codex-writers; no home attribution inferred",
  };
}
export async function assertCodexNativeOffline(witness, { signal, onProcess } = {}) {
  const saved = witnesses.get(witness);
  if (!saved) fail("NATIVE_CODEX_OFFLINE_WITNESS_REQUIRED");
  const current = homeBasis(saved.basis.root),
    engine = executableBasis(saved.engine.path);
  if (current.identity !== saved.basis.identity || engine.identity !== saved.engine.identity)
    fail("NATIVE_CODEX_OFFLINE_BASIS_CHANGED");
  const observation = await saved.probe({ signal, onProcess });
  if (!validateObservation(observation) || observation.rows.length)
    fail("NATIVE_CODEX_WRITER_STATE_UNCERTAIN");
  return {
    home: saved.basis.root,
    executable: saved.engine.path,
    engineVersion: saved.engineVersion,
    status: "stopped-at-check",
    nativeWriteAuthorized: false,
  };
}

// Official SDK lifecycle only. This checks the retained destination, not a
// present stopped-writer claim; it must never be used for raw/SQL publication.
export function codexNativeRegistrationScope(witness) {
  const saved = witnesses.get(witness);
  if (!saved) fail("NATIVE_CODEX_OFFLINE_WITNESS_REQUIRED");
  const current = homeBasis(saved.basis.root),
    engine = executableBasis(saved.engine.path);
  if (current.identity !== saved.basis.identity || engine.identity !== saved.engine.identity)
    fail("NATIVE_CODEX_OFFLINE_BASIS_CHANGED");
  return {
    home: saved.basis.root,
    executable: saved.engine.path,
    engineVersion: saved.engineVersion,
    scope: "official-sdk-metadata-only",
    offlineClaim: false,
    nativeWriteAuthorized: false,
  };
}

// Metadata lifecycle observation only. A live owned SDK is expected here;
// this is never a stopped-writer witness for raw/SQLite publication.
export async function observeCodexNativeRegistrationWriters(witness, { signal, onProcess } = {}) {
  codexNativeRegistrationScope(witness);
  const saved = witnesses.get(witness);
  const observed = await saved.probe({ signal, onProcess });
  if (!validateObservation(observed)) fail("NATIVE_CODEX_WRITER_STATE_UNCERTAIN");
  return observed.rows.map((row) => ({ ...row }));
}
