import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";

export const PROCESS_SUPERVISOR_PROTOCOL_VERSION = "0.1.0";
export const PROCESS_SUPERVISOR_MANIFEST_VERSION = "0.3.0";
export const PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION = "0.1.0";
export const RUNTIME_ONE_SHOT_CONTROL_VERSION = "0.1.0";
// P5 provenance only: a serialized/copy-shaped handle cannot acquire control of
// another process. Existing callers need no ownership binding.
const supervisedProcessHandles = new WeakMap();

const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ platform: "darwin", arch: "arm64", directory: "darwin-arm64", executable: "head-agent-supervisor" }),
  "darwin-x64": Object.freeze({ platform: "darwin", arch: "x64", directory: "darwin-x64", executable: "head-agent-supervisor" }),
  "linux-arm64": Object.freeze({ platform: "linux", arch: "arm64", directory: "linux-arm64", executable: "head-agent-supervisor" }),
  "linux-x64": Object.freeze({ platform: "linux", arch: "x64", directory: "linux-x64", executable: "head-agent-supervisor" }),
  "win32-x64": Object.freeze({ platform: "win32", arch: "x64", directory: "windows-x64", executable: "head-agent-supervisor.exe" }),
});

const fail = (message, code = "PROCESS_SUPERVISOR_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

function targetFor(platform = process.platform, arch = process.arch, legacy = false) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) fail(`Unsupported process-supervisor target: ${platform}-${arch}.`, "PROCESS_SUPERVISOR_TARGET_UNSUPPORTED");
  return legacy ? target : { ...target, executable: target.executable.replace("head-agent-", "lode-agent-") };
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, "INVALID_PROCESS_SUPERVISOR_MANIFEST");
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_PROCESS_SUPERVISOR_MANIFEST");
  }
}

function declaredCapabilities() {
  // Build metadata describes entry points. It does not prove that an operation
  // is supported for the current OS, filesystem, path, or requested effect.
  return {
    declarationOnly: true,
    processSupervision: {
      oneShotProtocolVersion: PROCESS_SUPERVISOR_PROTOCOL_VERSION,
      jobProtocolVersion: "0.1.0",
      detachedJobAvailability: "runtime-platform-preflight-required",
      interactiveProtocolVersion: PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION,
      interactiveTransport: "bounded-bootstrap-line-streaming-stdio",
    },
    fileEffects: {
      transport: "single-request-stdio",
      transportProtocolVersion: "0.1.0",
      imageProtocolVersion: "0.1.0",
      operations: ["probe", "inspect", "edit", "retry", "image-preflight", "image-apply", "image-inspect", "image-retry"],
      availability: "runtime-platform-and-target-preflight-required",
    },
  };
}

function operationalAuthority() {
  return {
    kind: "bounded-operational-process-and-file-effects",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    grantsExecutionAuthorization: false,
    grantsWriteAuthorization: false,
    // No semantic Canon transition is authorized by this manifest. The helper
    // has physical file-writing capabilities; Core must authorize and bind the
    // exact effects, and the platform adapter must verify current capability.
    mutatesCanon: false,
  };
}

function manifestPayload({ target, binary }) {
  return {
    schemaVersion: 2,
    kind: "LodeAgentProcessSupervisorManifest",
    manifestVersion: PROCESS_SUPERVISOR_MANIFEST_VERSION,
    supervisorProtocolVersion: PROCESS_SUPERVISOR_PROTOCOL_VERSION,
    target,
    binary,
    processModel: {
      transport: "single-request-stdio-with-control-fd3",
      windowsTreeOwnership: "job-object-kill-on-close",
      posixTreeOwnership: "isolated-process-group",
      shellInterpretation: false,
    },
    capabilities: declaredCapabilities(),
    authority: operationalAuthority(),
  };
}

function withIdentity(payload) {
  const manifestHash = digest(canonicalJson(payload));
  return { ...payload, manifestId: `process-supervisor-manifest-${manifestHash.slice(0, 24)}`, manifestHash };
}

export function createProcessSupervisorManifest({ platform, arch, binaryFile, manifestDirectory } = {}) {
  const target = targetFor(platform, arch);
  const root = path.resolve(manifestDirectory || ".");
  const file = path.resolve(binaryFile || "");
  if (!isWithin(root, file)) fail("Process supervisor binary must remain beneath its manifest directory.", "PROCESS_SUPERVISOR_PATH_ESCAPE");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("Process supervisor binary is missing or unsafe.", "PROCESS_SUPERVISOR_BINARY_MISSING");
  const relativePath = path.relative(root, file).replaceAll("\\", "/");
  if (relativePath !== target.executable) fail("Process supervisor binary name does not match its target.", "INVALID_PROCESS_SUPERVISOR_MANIFEST");
  return verifyProcessSupervisorManifest(withIdentity(manifestPayload({
    target: { platform: target.platform, arch: target.arch, directory: target.directory },
    binary: { relativePath, sha256: digest(fs.readFileSync(file)), size: stat.size },
  })), { platform, arch });
}

export function verifyProcessSupervisorManifest(manifest, { platform = process.platform, arch = process.arch } = {}) {
  assertFields(manifest, [
    "schemaVersion", "kind", "manifestVersion", "supervisorProtocolVersion", "target", "binary",
    "processModel", "capabilities", "authority", "manifestId", "manifestHash",
  ], "Process supervisor manifest");
  assertFields(manifest.target, ["platform", "arch", "directory"], "Process supervisor target");
  assertFields(manifest.binary, ["relativePath", "sha256", "size"], "Process supervisor binary");
  assertFields(manifest.processModel, ["transport", "windowsTreeOwnership", "posixTreeOwnership", "shellInterpretation"], "Process supervisor process model");
  assertFields(manifest.capabilities, ["declarationOnly", "processSupervision", "fileEffects"], "Process supervisor capabilities");
  assertFields(manifest.capabilities.processSupervision, ["oneShotProtocolVersion", "jobProtocolVersion", "detachedJobAvailability", "interactiveProtocolVersion", "interactiveTransport"], "Process supervision declaration");
  assertFields(manifest.capabilities.fileEffects, ["transport", "transportProtocolVersion", "imageProtocolVersion", "operations", "availability"], "File effect declaration");
  assertFields(manifest.authority, ["kind", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "grantsExecutionAuthorization", "grantsWriteAuthorization", "mutatesCanon"], "Process supervisor authority");
  const target = targetFor(platform, arch, manifest.kind === "HeadAgentProcessSupervisorManifest");
  const expectedTarget = { platform: target.platform, arch: target.arch, directory: target.directory };
  if (manifest.schemaVersion !== 2 || !["HeadAgentProcessSupervisorManifest", "LodeAgentProcessSupervisorManifest"].includes(manifest.kind)
    || manifest.manifestVersion !== PROCESS_SUPERVISOR_MANIFEST_VERSION
    || manifest.supervisorProtocolVersion !== PROCESS_SUPERVISOR_PROTOCOL_VERSION
    || canonicalJson(manifest.target) !== canonicalJson(expectedTarget)
    || manifest.binary.relativePath !== target.executable || !/^[a-f0-9]{64}$/.test(manifest.binary.sha256 || "")
    || !Number.isSafeInteger(manifest.binary.size) || manifest.binary.size < 1
    || canonicalJson(manifest.processModel) !== canonicalJson({
      transport: "single-request-stdio-with-control-fd3",
      windowsTreeOwnership: "job-object-kill-on-close",
      posixTreeOwnership: "isolated-process-group",
      shellInterpretation: false,
    })
    || canonicalJson(manifest.capabilities) !== canonicalJson(declaredCapabilities())
    || canonicalJson(manifest.authority) !== canonicalJson(operationalAuthority())) {
    fail("Process supervisor manifest contract is invalid.", "INVALID_PROCESS_SUPERVISOR_MANIFEST");
  }
  const payload = { ...manifest };
  delete payload.manifestId;
  delete payload.manifestHash;
  const expected = withIdentity(payload);
  if (manifest.manifestId !== expected.manifestId || manifest.manifestHash !== expected.manifestHash) {
    fail("Process supervisor manifest digest verification failed.", "PROCESS_SUPERVISOR_MANIFEST_DIGEST_MISMATCH");
  }
  return manifest;
}

export function defaultProcessSupervisorManifestPath({ pluginRoot = ".", platform = process.platform, arch = process.arch } = {}) {
  return path.join(path.resolve(pluginRoot), "dist", targetFor(platform, arch).directory, "SUPERVISOR-MANIFEST.json");
}

export function resolveVerifiedProcessSupervisor({ pluginRoot = ".", manifestFile = null, platform = process.platform, arch = process.arch } = {}) {
  const root = fs.realpathSync(path.resolve(pluginRoot));
  const manifestPath = path.resolve(manifestFile || defaultProcessSupervisorManifestPath({ pluginRoot: root, platform, arch }));
  if (!isWithin(root, manifestPath)) fail("Process supervisor manifest escaped the plugin distribution root.", "PROCESS_SUPERVISOR_PATH_ESCAPE");
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) fail("Process supervisor manifest is unavailable or unsafe.", "PROCESS_SUPERVISOR_NOT_AVAILABLE");
  const realManifest = fs.realpathSync(manifestPath);
  if (!isWithin(root, realManifest)) fail("Process supervisor manifest resolved outside the plugin distribution root.", "PROCESS_SUPERVISOR_PATH_ESCAPE");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(realManifest, "utf8")); }
  catch { fail("Process supervisor manifest is not valid JSON.", "INVALID_PROCESS_SUPERVISOR_MANIFEST"); }
  verifyProcessSupervisorManifest(manifest, { platform, arch });
  const binaryPath = path.resolve(path.dirname(realManifest), manifest.binary.relativePath);
  const binaryStat = fs.lstatSync(binaryPath, { throwIfNoEntry: false });
  if (!isWithin(root, binaryPath) || !binaryStat?.isFile() || binaryStat.isSymbolicLink()) {
    fail("Process supervisor binary is unavailable or unsafe.", "PROCESS_SUPERVISOR_BINARY_MISSING");
  }
  const realBinary = fs.realpathSync(binaryPath);
  if (!isWithin(root, realBinary) || path.dirname(realBinary) !== path.dirname(realManifest)) {
    fail("Process supervisor binary resolved outside its immutable distribution directory.", "PROCESS_SUPERVISOR_PATH_ESCAPE");
  }
  if (platform !== "win32" && (binaryStat.mode & 0o111) === 0) fail("Process supervisor binary is not executable.", "PROCESS_SUPERVISOR_BINARY_NOT_EXECUTABLE");
  const bytes = fs.readFileSync(realBinary);
  if (bytes.length !== manifest.binary.size || digest(bytes) !== manifest.binary.sha256) {
    fail("Process supervisor binary digest verification failed.", "PROCESS_SUPERVISOR_BINARY_DIGEST_MISMATCH");
  }
  return Object.freeze({ manifest, manifestPath: realManifest, binaryPath: realBinary });
}

function minimalSupervisorEnvironment(environment = process.env) {
  const allowed = new Set(["systemroot", "windir", "temp", "tmp", "tmpdir", "lang", "lc_all"]);
  const result = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string") result[key] = value;
  }
  result.LANG = "C";
  return result;
}

function boundedSupervisorRequest({ executablePath, args, cwd, providerEnvironment, input, controlFile, terminationGraceMs }) {
  if (!path.isAbsolute(executablePath) || !path.isAbsolute(cwd) || !Buffer.isBuffer(input)
    || input.length > 4 * 1024 * 1024 || !path.isAbsolute(controlFile) || controlFile.includes("\0") || fs.existsSync(controlFile)
    || !Array.isArray(args) || args.length > 256 || args.some((item) => typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > 64 * 1024)
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 100 || terminationGraceMs > 10_000) {
    fail("Process supervisor request is outside its fixed boundary.", "INVALID_PROCESS_SUPERVISOR_REQUEST");
  }
  const environment = {};
  const environmentEntries = Object.entries(providerEnvironment || {});
  if (environmentEntries.length > 256) fail("Provider environment exceeds its supervised execution bound.", "INVALID_PROCESS_SUPERVISOR_REQUEST");
  for (const [key, value] of environmentEntries) {
    if (!key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")
      || Buffer.byteLength(key) + Buffer.byteLength(value) > 64 * 1024) {
      fail("Provider environment is invalid for supervised execution.", "INVALID_PROCESS_SUPERVISOR_REQUEST");
    }
    environment[key] = value;
  }
  const request = {
    schemaVersion: 1,
    protocolVersion: PROCESS_SUPERVISOR_PROTOCOL_VERSION,
    executable: executablePath,
    arguments: [...args],
    workingDirectory: cwd,
    environment,
    inputBase64: input.toString("base64"),
    controlFile,
    terminationGraceMs,
  };
  const bytes = Buffer.from(canonicalJson(request), "utf8");
  if (bytes.length > 8 * 1024 * 1024) fail("Process supervisor request exceeds its transport bound.", "PROCESS_SUPERVISOR_REQUEST_LIMIT");
  return bytes;
}

function validateControlEvent(value, expectedStrategy = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.protocolVersion !== PROCESS_SUPERVISOR_PROTOCOL_VERSION
    || !new Set(["supervisor.ready", "provider.started", "provider.exited", "supervisor.cleanup"]).has(value.type)) {
    fail("Process supervisor emitted an invalid control event.", "INVALID_PROCESS_SUPERVISOR_CONTROL_EVENT");
  }
  if (value.type !== "provider.exited" && !new Set(["windows-job-object", "posix-process-group"]).has(value.strategy)) {
    fail("Process supervisor emitted an invalid ownership strategy.", "INVALID_PROCESS_SUPERVISOR_CONTROL_EVENT");
  }
  if (expectedStrategy && value.strategy && value.strategy !== expectedStrategy) fail("Process supervisor strategy changed during execution.", "PROCESS_SUPERVISOR_STRATEGY_DRIFT");
  if (value.type === "supervisor.ready" && value.treeOwnershipEstablished !== true) fail("Process supervisor did not establish tree ownership.", "PROCESS_SUPERVISOR_OWNERSHIP_FAILED");
  if (value.type === "provider.started" && (!Number.isSafeInteger(value.providerPid) || value.providerPid < 1 || value.treeOwnershipEstablished !== true)) {
    fail("Process supervisor provider start event is invalid.", "INVALID_PROCESS_SUPERVISOR_CONTROL_EVENT");
  }
  if (value.type === "provider.exited" && (!Number.isSafeInteger(value.providerPid) || value.providerPid < 1 || !Number.isInteger(value.exitCode))) {
    fail("Process supervisor provider exit event is invalid.", "INVALID_PROCESS_SUPERVISOR_CONTROL_EVENT");
  }
  if (value.type === "supervisor.cleanup" && [value.cleanupAttempted, value.cleanupVerified, value.forceUsed, value.kernelCleanupOnExit].some((item) => typeof item !== "boolean")) {
    fail("Process supervisor cleanup event is invalid.", "INVALID_PROCESS_SUPERVISOR_CONTROL_EVENT");
  }
  return value;
}

function processGroupSignal(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === "win32") return;
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

export function spawnSupervisedProcess({
  selection,
  executablePath,
  args,
  cwd,
  providerEnvironment,
  input,
  controlFile,
  terminationGraceMs,
  spawnImplementation = spawn,
  onControlEvent = () => {},
  ownershipBinding = null,
  interactive = null,
} = {}) {
  if (!selection?.manifest || !selection?.binaryPath) fail("A verified process supervisor selection is required.", "PROCESS_SUPERVISOR_SELECTION_REQUIRED");
  verifyProcessSupervisorManifest(selection.manifest);
  if (ownershipBinding !== null) {
    // A proof-bearing handle must come from the exact verified native binary,
    // not merely from an object carrying a valid but unrelated manifest.
    if (typeof selection.manifestPath !== "string" || !path.isAbsolute(selection.manifestPath)) fail("Owned supervisor manifest path is unavailable.", "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH");
    const current = resolveVerifiedProcessSupervisor({ pluginRoot: path.dirname(selection.manifestPath), manifestFile: selection.manifestPath });
    if (current.binaryPath !== selection.binaryPath || current.manifest.manifestHash !== selection.manifest.manifestHash) {
      fail("Owned supervisor binary differs from its verified manifest.", "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH");
    }
  }
  let request = boundedSupervisorRequest({ executablePath, args, cwd, providerEnvironment, input, controlFile, terminationGraceMs });
  if (interactive !== null) {
    if (!interactive || Object.keys(interactive).some(key => key !== "timeoutMs")
      || !Number.isSafeInteger(interactive.timeoutMs) || interactive.timeoutMs < 100 || interactive.timeoutMs > 3_600_000
      || input.length !== 0) fail("Interactive supervisor requires an empty bounded bootstrap and lifetime.", "INVALID_PROCESS_SUPERVISOR_REQUEST");
    request = Buffer.from(`${canonicalJson({ ...JSON.parse(request), interactiveProtocolVersion: PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION, timeoutMs: interactive.timeoutMs })}\n`);
    if (request.length > 8 * 1024 * 1024) fail("Interactive bootstrap exceeds its bound.", "PROCESS_SUPERVISOR_REQUEST_LIMIT");
  }
  const provenance = { actualSpawn: spawnImplementation === spawn,
    executablePathDigest: controlDigest(path.resolve(executablePath)), executionRootDigest: controlDigest(path.resolve(cwd)),
    supervisorManifestDigest: selection.manifest.manifestHash,
    ownershipBinding: ownershipBinding === null ? null : canonicalControlJson(ownershipBinding) };
  const createdAt = Date.now();
  const child = spawnImplementation(process.platform === "win32" ? path.toNamespacedPath(selection.binaryPath) : selection.binaryPath, interactive === null ? [] : ["--interactive"], {
    cwd,
    env: minimalSupervisorEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = {
    controlInvalid: false,
    strategy: null,
    ownershipEstablished: false,
    providerStarted: false,
    providerPid: null,
    providerExitObserved: false,
    cleanup: null,
    requestWritten: false,
  };
  let controlBuffer = "";
  let controlBytesRead = 0;
  const consume = (line) => {
    if (!line.trim() || state.controlInvalid) return;
    try {
      const event = validateControlEvent(JSON.parse(line), state.strategy);
      if (event.strategy) state.strategy = event.strategy;
      if (event.type === "supervisor.ready") state.ownershipEstablished = true;
      if (event.type === "provider.started") {
        state.providerStarted = true;
        state.providerPid = event.providerPid;
      }
      if (event.type === "provider.exited") {
        if (event.providerPid !== state.providerPid) throw Object.assign(new Error("Provider PID changed."), { code: "PROCESS_SUPERVISOR_PROVIDER_DRIFT" });
        state.providerExitObserved = true;
      }
      if (event.type === "supervisor.cleanup") state.cleanup = event;
      onControlEvent(event);
    } catch {
      state.controlInvalid = true;
      try { child.kill("SIGTERM"); } catch {}
    }
  };
  const readControlFile = () => {
    if (!fs.existsSync(controlFile) || state.controlInvalid) return;
    const stat = fs.lstatSync(controlFile);
    const resolvedParent = fs.realpathSync(path.dirname(controlFile));
    if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(resolvedParent, fs.realpathSync(controlFile)) || stat.size < controlBytesRead || stat.size > 64 * 1024) {
      state.controlInvalid = true;
      try { child.kill("SIGTERM"); } catch {}
      return;
    }
    const bytes = fs.readFileSync(controlFile);
    const chunk = bytes.subarray(controlBytesRead);
    controlBytesRead = bytes.length;
    controlBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(controlBuffer) > 64 * 1024) {
      state.controlInvalid = true;
      try { child.kill("SIGTERM"); } catch {}
      return;
    }
    const lines = controlBuffer.split(/\r?\n/);
    controlBuffer = lines.pop() || "";
    for (const line of lines) consume(line);
  };
  const controlPoll = setInterval(readControlFile, 20);
  controlPoll.unref?.();
  child.once("close", () => {
    clearInterval(controlPoll);
    readControlFile();
  });
  let writeInput;
  let endInput;
  if (interactive === null) {
    child.once("spawn", () => { child.stdin.end(request, () => { state.requestWritten = true; }); });
  } else {
    let ended = false;
    let guardedInput = false;
    let readyResolve;
    let readyReject;
    let queue = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    queue.catch(() => {});
    child.once("error", readyReject);
    child.stdin.on("error", readyReject);
    child.once("spawn", () => {
      child.stdin.write(request, error => {
        if (error) readyReject(error);
        else { state.requestWritten = true; readyResolve(); }
      });
    });
    writeInput = (bytes, { beforeWrite = null, signal = null, deadlineAt = null } = {}) => {
      let writeAttempted = false;
      const guarded = beforeWrite !== null || signal !== null || deadlineAt !== null;
      const inputError = code => Object.assign(new Error(code), { code });
      let delivery;
      if (ended || !Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) {
        delivery = Promise.reject(inputError("PROCESS_SUPERVISOR_INPUT_CLOSED"));
      } else if (beforeWrite !== null && typeof beforeWrite !== "function" || deadlineAt !== null && !Number.isSafeInteger(deadlineAt)) {
        delivery = Promise.reject(inputError("PROCESS_SUPERVISOR_INPUT_GUARD_INVALID"));
      } else {
        guardedInput ||= guarded;
        delivery = queue.then(() => new Promise((resolve, reject) => {
          try {
            if (guarded) {
              // Run after bootstrap and all preceding write callbacks, not when
              // enqueued. A guard may synchronously close/cancel this stream.
              const returned = beforeWrite?.();
              if (returned && typeof returned.then === "function") {
                Promise.resolve(returned).catch(() => {});
                throw inputError("PROCESS_SUPERVISOR_SYNCHRONOUS_INPUT_GUARD_REQUIRED");
              }
              if (signal?.aborted) throw inputError("PROCESS_SUPERVISOR_INPUT_CANCELLED");
              if (deadlineAt !== null && deadlineAt <= Date.now()) throw inputError("PROCESS_SUPERVISOR_INPUT_DEADLINE");
              if (ended || terminationRequested || child.exitCode !== null || child.signalCode !== null
                || child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) throw inputError("PROCESS_SUPERVISOR_INPUT_CLOSED");
            }
            // Local P5 observation only: entering write may partially deliver
            // bytes even if its callback later fails. It is not authority proof.
            writeAttempted = true;
            child.stdin.write(bytes, error => error ? reject(error) : resolve());
          } catch (cause) { reject(cause); }
        }));
        queue = delivery;
      }
      Object.defineProperty(delivery, "writeAttempted", { get: () => writeAttempted });
      delivery.catch(() => {});
      return delivery;
    };
    endInput = () => {
      if (ended) return queue;
      ended = true;
      // A rejected guarded write still needs graceful EOF. Keep that write's
      // rejection and preserve existing unguarded drain-before-EOF semantics.
      queue = (guardedInput ? queue.catch(() => {}) : queue).then(() => new Promise((resolve, reject) => child.stdin.end(error => error ? reject(error) : resolve())));
      queue.catch(() => {});
      return queue;
    };
  }
  let terminationRequested = false;
  const terminate = (force = false) => {
    terminationRequested = true;
    const signal = force ? "SIGKILL" : "SIGTERM";
    processGroupSignal(state.providerPid, signal);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch {}
    }
  };
  const finalize = ({ exactSupervisorExitObserved, terminationRequested }) => {
    readControlFile();
    if (controlBuffer.trim()) consume(controlBuffer);
    const expectedStrategy = process.platform === "win32" ? "windows-job-object" : "posix-process-group";
    const windowsKernelBoundary = state.strategy === "windows-job-object" && state.ownershipEstablished
      && state.providerStarted && exactSupervisorExitObserved;
    const cleanupVerified = state.cleanup?.cleanupVerified === true
      || windowsKernelBoundary && (state.cleanup?.kernelCleanupOnExit === true || terminationRequested);
    return Object.freeze({
      supervisionMode: "native-process-tree",
      supervisionStrategy: state.strategy || "unavailable",
      supervisorManifestDigest: selection.manifest.manifestHash,
      ownershipEstablished: state.ownershipEstablished && state.strategy === expectedStrategy && !state.controlInvalid,
      providerChildStarted: state.providerStarted,
      providerChildExitObserved: state.providerExitObserved,
      treeCleanupAttempted: state.cleanup?.cleanupAttempted === true || terminationRequested,
      treeCleanupVerified: cleanupVerified && !state.controlInvalid,
      requestWritten: state.requestWritten,
      providerPid: state.providerPid,
      controlInvalid: state.controlInvalid,
    });
  };
  const handle = { child, state, terminate, finalize, ...(interactive === null ? {} : { writeInput, endInput }) };
  supervisedProcessHandles.set(handle, { child, terminate, finalize, createdAt, terminationRequested: () => terminationRequested, ...provenance });
  return handle;
}

export function verifyRuntimeProcessSupervisorHandle(handle, { ownershipBinding, executablePathDigest,
  executionRootDigest, supervisorManifestDigest, notBefore = 0, requireActualSpawn = true } = {}) {
  const owner = supervisedProcessHandles.get(handle);
  if (!owner || handle.child !== owner.child || handle.terminate !== owner.terminate || handle.finalize !== owner.finalize
    || !ownershipBinding || owner.ownershipBinding !== canonicalControlJson(ownershipBinding)
    || executablePathDigest !== undefined && owner.executablePathDigest !== executablePathDigest
    || executionRootDigest !== undefined && owner.executionRootDigest !== executionRootDigest
    || supervisorManifestDigest !== undefined && owner.supervisorManifestDigest !== supervisorManifestDigest || !Number.isSafeInteger(notBefore)
    || owner.createdAt < notBefore || requireActualSpawn && !owner.actualSpawn) {
    fail("Process supervisor handle is not the exact owned invocation transport.", "RUNTIME_SUPERVISOR_HANDLE_OWNERSHIP_MISMATCH");
  }
  // Without target expectations this establishes only exact task ownership for
  // protective cleanup. Execution must also supply all three target digests.
  return Object.freeze({ createdAt: owner.createdAt, pid: owner.child.pid, actualSpawn: owner.actualSpawn, terminationRequested: owner.terminationRequested() });
}

function canonicalControlValue(value) {
  if (Array.isArray(value)) return value.map(canonicalControlValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalControlValue(value[key])]));
  }
  return value;
}

const canonicalControlJson = (value) => JSON.stringify(canonicalControlValue(value));
const controlDigest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function spawnBoundedRuntimeOneShot(options = {}) {
  const runtime = String(options.runtime || "").trim().toLowerCase();
  if (!new Set(["claude", "codex", "opencode"]).has(runtime)) {
    fail("Bounded runtime control requires an explicit supported runtime.", "RUNTIME_ONE_SHOT_CONTROL_RUNTIME_REQUIRED");
  }
  const controlPrefix = formatForVerifiedOwner(options.storage).dialect === "lode" ? "lode-agent-runtime-control" : "head-agent-runtime-control";
  const supervised = spawnSupervisedProcess(options);
  const controlToken = crypto.randomBytes(32).toString("base64url");
  const controlTokenHash = controlDigest(`${controlPrefix}\n${runtime}\n${controlToken}`);
  let action = null;
  let finalized = null;

  const authenticate = (provided) => {
    const observed = controlDigest(`${controlPrefix}\n${runtime}\n${String(provided || "")}`);
    const left = Buffer.from(controlTokenHash, "hex");
    const right = Buffer.from(observed, "hex");
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      fail("Runtime one-shot control token is invalid.", "RUNTIME_ONE_SHOT_CONTROL_UNAUTHORIZED");
    }
  };
  const request = (requestedAction, provided) => {
    authenticate(provided);
    if (finalized) fail("Runtime one-shot control is already finalized.", "RUNTIME_ONE_SHOT_CONTROL_FINALIZED");
    if (action && action !== requestedAction) {
      fail(`Runtime one-shot control already accepted ${action}.`, "RUNTIME_ONE_SHOT_CONTROL_CONFLICT");
    }
    if (!action) {
      action = requestedAction;
      supervised.terminate(false);
    }
    return Object.freeze({ status: `${requestedAction}_requested`, action: requestedAction, bounded: true });
  };
  const unsupported = (operation) => {
    fail(`Runtime one-shot ${operation} remains deferred; use canonical recovery and a new authorization instead.`, "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED");
  };
  const finalizeControl = ({ token, exactSupervisorExitObserved = true } = {}) => {
    authenticate(token);
    if (finalized) return finalized;
    const supervision = supervised.finalize({
      exactSupervisorExitObserved,
      terminationRequested: action !== null,
    });
    const payload = {
      schemaVersion: 1,
      kind: "RuntimeOneShotControlReceipt",
      protocolVersion: RUNTIME_ONE_SHOT_CONTROL_VERSION,
      runtime,
      controlScope: "exact-owned-one-shot-provider-tree",
      action,
      actionAccepted: action !== null,
      supervisionMode: supervision.supervisionMode,
      supervisionStrategy: supervision.supervisionStrategy,
      ownershipEstablished: supervision.ownershipEstablished,
      providerChildStarted: supervision.providerChildStarted,
      providerChildExitObserved: supervision.providerChildExitObserved,
      treeCleanupAttempted: supervision.treeCleanupAttempted,
      treeCleanupVerified: supervision.treeCleanupVerified,
      controlTokenPersisted: false,
      providerSessionIdentityPersisted: false,
      resumeEnabled: false,
      streamEnabled: false,
      instructionAuthority: false,
      promotionAuthority: false,
      reviewAuthority: false,
      canonMutationAuthority: false,
    };
    const receiptHash = controlDigest(canonicalControlJson(payload));
    finalized = Object.freeze({
      ...payload,
      receiptId: `runtime-one-shot-control-${receiptHash.slice(0, 24)}`,
      receiptHash,
    });
    return finalized;
  };
  return Object.freeze({
    child: supervised.child,
    state: supervised.state,
    controlToken,
    interrupt: ({ token } = {}) => request("interrupt", token),
    close: ({ token } = {}) => request("close", token),
    resume: () => unsupported("resume"),
    stream: () => unsupported("stream"),
    finalize: finalizeControl,
  });
}
