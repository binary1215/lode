import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSupervisedProcess, resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, readCopiedProjectExcerpt } from "./project-copy-evidence.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";

export const nativeFail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export const nativeHash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
export const nativeJson = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
export function nativeCheck(signal, check = () => {}) {
  if (signal?.aborted) nativeFail("NATIVE_HISTORY_OPERATION_CANCELLED");
  const result = check();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    nativeFail("NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
}
export function nativeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) nativeFail("NATIVE_HISTORY_EXACT_ROOT_REQUIRED");
  const absolute = path.resolve(root),
    base = path.parse(absolute).root;
  let current = base;
  for (const item of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, item);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) nativeFail("NATIVE_HISTORY_UNSAFE_ROOT");
  }
  return fs.realpathSync(absolute);
}
export function pinNativeRoot(root) {
  const selected = nativeRoot(root),
    original = fs.lstatSync(selected);
  return {
    root: selected,
    verify() {
      if (nativeRoot(selected) !== selected) nativeFail("NATIVE_HISTORY_ROOT_CHANGED");
      const current = fs.lstatSync(selected);
      if (current.dev !== original.dev || current.ino !== original.ino) nativeFail("NATIVE_HISTORY_ROOT_CHANGED");
    },
  };
}
export function nativeRaw(root, relative, signal, check) {
  const entry = inspectCopiedProjectFile(root, relative, { signal, assertCurrentAuthority: check });
  if (entry.bytes > SNAPSHOT_STORAGE_LIMITS.decodedBytes) nativeFail("NATIVE_HISTORY_FORMAT_READ_LIMIT");
  const raw = readCopiedProjectExcerpt(root, entry, { maxBytes: Math.max(1, entry.bytes), signal, assertCurrentAuthority: check }).bytes;
  return { entry, raw };
}
export function nativeObject(native, entry, signal, check) {
  const read = nativeRaw(native.directory, "objects/" + entry.sha256 + ".bin", signal, check);
  if (read.entry.bytes !== entry.bytes || read.entry.sha256 !== entry.sha256) nativeFail("NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
  return read.raw;
}
export function nativeSeparate(a, b) {
  for (const [base, file] of [
    [a, b],
    [b, a],
  ]) {
    const rel = path.relative(base, file);
    if (!rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))) nativeFail("PROJECT_NATIVE_SOURCE_TARGET_OVERLAP");
  }
}
export const nativeOutcome = (provider, extra = {}) => ({
  provider,
  authorityPlane: "P5",
  ordinaryCoreBlocked: false,
  commonBundleReadable: true,
  handoffIndependent: true,
  continuationReady: false,
  targetExecutionSettingsVerified: false,
  modelTurnStarted: false,
  pickerVisibility: "not-observed",
  grantsRecoveryAuthority: false,
  restoresExecutionPermission: false,
  automaticReplayAllowed: false,
  ...extra,
});

// Only current destination environment; no provider account/config environment
// is inherited. Profile roots are per-call and never change global settings.
export function nativeEnvironment(provider, home) {
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  if (provider === "claude") return { ...env, CLAUDE_CONFIG_DIR: home };
  return {
    ...env,
    HOME: path.join(home, "home"),
    USERPROFILE: path.join(home, "home"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    TMPDIR: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    TEMP: path.join(home, "tmp"),
    OPENCODE_CONFIG_DIR: path.join(home, "config"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
}

// Finite command adapter. No prompt/run/resume/server command is accepted.
// Native Job Object/process-group supervision owns cleanup, including failure.
export function createProviderNativeHost({ provider, executable, pluginRoot, signal, onProcess = () => {} }) {
  if (!["claude", "opencode"].includes(provider)) nativeFail("NATIVE_HISTORY_PROVIDER_UNSUPPORTED");
  const selectedExe = path.resolve(executable || "");
  const parent = nativeRoot(path.dirname(selectedExe));
  const identity = inspectCopiedProjectFile(parent, path.basename(selectedExe));
  const verifyExe = () => {
    const now = inspectCopiedProjectFile(parent, path.basename(selectedExe));
    if (now.sha256 !== identity.sha256 || now.bytes !== identity.bytes) nativeFail("NATIVE_HISTORY_EXECUTABLE_CHANGED");
  };
  let selection;
  const sdkReaderFile = fileURLToPath(new URL("../read-claude-native-history.mjs", import.meta.url));
  let sdkEntry = null,
    sdkDiscoveryFailure = null;
  try {
    const require = createRequire(import.meta.url),
      entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    let directory = path.dirname(entry);
    for (let index = 0; index < 4; index++, directory = path.dirname(directory)) {
      const file = path.join(directory, "package.json");
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg.name === "@anthropic-ai/claude-agent-sdk" && pkg.version === "0.3.234") sdkEntry = entry;
      break;
    }
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") sdkDiscoveryFailure = error;
    // Optional SDK absence is distinct from malformed/denied installed content.
  }
  const run = async ({ args, cwd, home, observer = false, sdkReader = false }) => {
    nativeCheck(signal);
    verifyExe();
    nativeRoot(cwd);
    nativeRoot(home);
    if (sdkReader && (provider !== "claude" || !sdkEntry || args[0] !== sdkReaderFile || args[1] !== sdkEntry))
      nativeFail("NATIVE_HISTORY_COMMAND_NOT_ALLOWED");
    if (
      !observer &&
      !sdkReader &&
      !(args.length === 1 && args[0] === "--version") &&
      !(provider === "opencode" && ((args.length === 2 && ["import", "export"].includes(args[0])) || args.join(" ") === "session list --format json"))
    )
      nativeFail("NATIVE_HISTORY_COMMAND_NOT_ALLOWED");
    selection ??= resolveVerifiedProcessSupervisor({ pluginRoot });
    const controlRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-native-command-")));
    let handle,
      failure = null,
      exited = false,
      terminationRequested = false;
    const report = (event) => {
      try {
        onProcess({ ...event, ports: [], windowsHide: true });
      } catch {}
    };
    const command = observer
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
      : sdkReader
        ? process.execPath
        : selectedExe;
    report({ event: "planned", command, args, cwd, parentPid: process.pid });
    const stdout = [],
      stderr = [];
    let total = 0,
      exitCode = null;
    try {
      handle = spawnSupervisedProcess({
        selection,
        executablePath: command,
        args,
        cwd,
        providerEnvironment: observer
          ? Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
          : nativeEnvironment(provider, home),
        input: Buffer.alloc(0),
        controlFile: copiedProjectFile(controlRoot, "control.jsonl"),
        terminationGraceMs: 1500,
        onControlEvent: (control) => report({ event: "supervision", control }),
      });
      report({ event: "started", pid: handle.child.pid, parentPid: process.pid, startedAt: new Date().toISOString(), command, args, cwd });
      const stop = (code) => {
        failure ??= Object.assign(new Error(code), { code });
        terminationRequested = true;
        handle.terminate(false);
      };
      const abort = () => stop("NATIVE_HISTORY_OPERATION_CANCELLED");
      const timer = setTimeout(() => stop("NATIVE_HISTORY_COMMAND_TIMEOUT"), 60000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        for (const [stream, chunks] of [
          [handle.child.stdout, stdout],
          [handle.child.stderr, stderr],
        ])
          stream.on("data", (bytes) => {
            total += bytes.length;
            if (total > SNAPSHOT_STORAGE_LIMITS.decodedBytes) stop("NATIVE_HISTORY_COMMAND_OUTPUT_LIMIT");
            else chunks.push(Buffer.from(bytes));
          });
        handle.child.stdin.on("error", (error) => {
          failure ??= error;
        });
        handle.child.on("error", (error) => {
          failure ??= error;
        });
        if (signal?.aborted) abort();
        await new Promise((resolve) =>
          handle.child.once("close", (code) => {
            exitCode = code;
            exited = true;
            resolve();
          }),
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      const supervision = handle.finalize({ exactSupervisorExitObserved: exited, terminationRequested });
      report({ event: "closed", pid: handle.child.pid, parentPid: process.pid, exitCode, supervision });
      if (!supervision.ownershipEstablished || !supervision.treeCleanupVerified) {
        const cleanup = Object.assign(new Error("NATIVE_HISTORY_PROCESS_CLEANUP_UNCERTAIN"), { code: "NATIVE_HISTORY_PROCESS_CLEANUP_UNCERTAIN" });
        if (failure) failure.nativeCleanupFailure = cleanup.code;
        else failure = cleanup;
      }
      if (failure) throw failure;
      verifyExe();
      if (exitCode !== 0) nativeFail("NATIVE_HISTORY_CLIENT_COMMAND_FAILED");
      return { stdout: Buffer.concat(stdout), stderrBytes: Buffer.concat(stderr).length, exitCode, supervision };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (handle && !exited) {
        try {
          handle.terminate(true);
        } catch (error) {
          if (failure) failure.nativeCleanupFailure = error.code;
        }
      }
      // Only our exact private control directory. Preserve changed/unexpected files.
      try {
        for (const name of fs.readdirSync(controlRoot)) {
          if (name !== "control.jsonl") nativeFail("NATIVE_HISTORY_CONTROL_CLEANUP_CHANGED");
          const file = copiedProjectFile(controlRoot, name),
            stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.nlink !== 1) nativeFail("NATIVE_HISTORY_CONTROL_CLEANUP_CHANGED");
          fs.unlinkSync(file);
        }
        fs.rmdirSync(controlRoot);
      } catch (error) {
        if (failure) failure.nativeControlCleanupFailure = error.code;
        else throw error;
      }
    }
  };
  return {
    provider,
    evidenceKind: "external-client-command-unqualified",
    executableDigest: identity.sha256,
    run,
    async version({ cwd, home }) {
      const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-native-version-")));
      const owner = fs.lstatSync(probe);
      let failure = null;
      try {
        for (const name of ["home", "config", "data", "cache", "state", "tmp"]) fs.mkdirSync(copiedProjectFile(probe, name));
        const result = await run({ args: ["--version"], cwd, home: probe });
        const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
        return /^(?:[A-Za-z ]+ )?(\d+\.\d+\.\d+)(?:[ ()A-Za-z-]*)$/.exec(text)?.[1] ?? null;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          const current = fs.lstatSync(probe);
          if (current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino || nativeRoot(probe) !== probe)
            nativeFail("NATIVE_HISTORY_VERSION_CLEANUP_CHANGED");
          fs.rmSync(probe, { recursive: true });
        } catch (error) {
          if (failure) failure.nativeVersionCleanupFailure = error.code;
          else throw error;
        }
      }
    },
    ...(sdkDiscoveryFailure
      ? {
          async readClaude() {
            throw sdkDiscoveryFailure;
          },
        }
      : {}),
    ...(sdkEntry
      ? {
          async readClaude({ home, cwd, nativeIds }) {
            const result = await run({ args: [sdkReaderFile, sdkEntry, cwd, JSON.stringify(nativeIds)], cwd, home, sdkReader: true });
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
          },
        }
      : {}),
    async writers({ cwd, home }) {
      if (process.platform !== "win32" || path.basename(selectedExe).toLowerCase() !== provider + ".exe") return { status: "unavailable", writers: [] };
      const script =
        "$rows=@(Get-CimInstance Win32_Process -Filter \"Name = '" +
        provider +
        ".exe'\" -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {@{pid=[long]$_.ProcessId;parentPid=[long]$_.ParentProcessId;birth=$_.CreationDate.ToUniversalTime().ToString('o')}});@{status='observed';writers=$rows}|ConvertTo-Json -Depth 4 -Compress";
      const result = await run({ args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], cwd, home, observer: true });
      const observed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).replace(/^\uFEFF/, ""));
      if (
        observed.status !== "observed" ||
        !Array.isArray(observed.writers) ||
        observed.writers.some((row) => !Number.isSafeInteger(row.pid) || row.pid < 1 || typeof row.birth !== "string")
      )
        nativeFail("NATIVE_HISTORY_WRITER_OBSERVATION_INVALID");
      return observed;
    },
  };
}
