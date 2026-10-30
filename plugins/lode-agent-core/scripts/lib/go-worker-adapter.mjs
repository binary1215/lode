import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import {
  COMPUTE_ADAPTER_CONTRACT_VERSION,
  JsReferenceComputeAdapter,
  validateComputeAdapter,
  validateComputeRequest,
  validateComputeResponse,
  WORKER_PROTOCOL_VERSION,
} from "./compute-adapter.mjs";

export const GO_WORKER_ADAPTER_VERSION = "0.1.0";
export const GO_WORKER_MANIFEST_VERSION = "0.1.0";
export const WORKER_HEALTH_OPERATION = "worker.health.v1";
export const WORKER_HEALTH_SEMANTIC_PRODUCER = Object.freeze({
  name: "head-agent-core-worker-health",
  version: "0.1.0",
});
export const WORKER_HEALTH_INPUT = Object.freeze({ probe: "head-agent-core" });
export const WORKER_LIFECYCLE_OPERATION = "worker.lifecycle.v1";
export const WORKER_LIFECYCLE_SEMANTIC_PRODUCER = Object.freeze({
  name: "head-agent-core-worker-lifecycle",
  version: "0.1.0",
});
export const WORKER_LIFECYCLE_INPUT = Object.freeze({ mode: "wait-for-cancellation" });

const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ platform: "darwin", arch: "arm64", directory: "darwin-arm64", executable: "head-agent-worker" }),
  "darwin-x64": Object.freeze({ platform: "darwin", arch: "x64", directory: "darwin-x64", executable: "head-agent-worker" }),
  "linux-arm64": Object.freeze({ platform: "linux", arch: "arm64", directory: "linux-arm64", executable: "head-agent-worker" }),
  "linux-x64": Object.freeze({ platform: "linux", arch: "x64", directory: "linux-x64", executable: "head-agent-worker" }),
  "win32-x64": Object.freeze({ platform: "win32", arch: "x64", directory: "windows-x64", executable: "head-agent-worker.exe" }),
});
const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{2,127}\.v[1-9][0-9]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECOVERABLE_NATIVE_CODES = new Set([
  "GO_WORKER_NOT_AVAILABLE",
  "GO_WORKER_SPAWN_FAILED",
  "GO_WORKER_CRASHED",
  "GO_WORKER_STDIN_FAILED",
]);
const DIAGNOSTIC_FIELDS = new Set([
  "backend", "adapterName", "executionMode", "fallbackUsed", "fallbackReasonCode",
  "workerPid", "workerRelativePath", "workerSha256",
]);

const fail = (message, code = "GO_WORKER_ERROR", details = null) => {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_GO_WORKER_MANIFEST");
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (unexpected.length || missing.length) fail(`${label} fields are invalid.`, "INVALID_GO_WORKER_MANIFEST", { unexpected: unexpected.sort(), missing: missing.sort() });
}

function normalizedRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`${label} must be a normalized relative path.`, "INVALID_GO_WORKER_MANIFEST");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`${label} escapes its manifest directory.`, "INVALID_GO_WORKER_MANIFEST");
  return value;
}

function targetFor(platform = process.platform, arch = process.arch, legacy = false) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) fail(`Unsupported Go worker target: ${platform}-${arch}`, "GO_WORKER_TARGET_UNSUPPORTED");
  return legacy ? target : { ...target, executable: target.executable.replace("head-agent-", "lode-agent-") };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function manifestPayload({ target, binary, operations }) {
  return {
    schemaVersion: 1,
    kind: "LodeAgentWorkerManifest",
    manifestVersion: GO_WORKER_MANIFEST_VERSION,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    target,
    binary,
    operations,
    processModel: {
      stdio: "single-request-single-response-json",
      descendants: "forbidden",
      network: "forbidden",
      projectWrites: "forbidden",
    },
    authority: {
      kind: "computation-only",
      instructionAuthority: false,
      promotionAuthority: false,
      controlAuthority: false,
      mutatesProject: false,
      mutatesCanon: false,
    },
  };
}

function withManifestIdentity(payload) {
  const manifestHash = digest(canonicalJson(payload));
  return { ...payload, manifestId: `go-worker-manifest-${manifestHash.slice(0, 24)}`, manifestHash };
}

export function createGoWorkerManifest({ platform, arch, binaryFile, manifestDirectory, operations = [WORKER_HEALTH_OPERATION] } = {}) {
  const target = targetFor(platform, arch);
  const root = path.resolve(manifestDirectory || ".");
  const file = path.resolve(binaryFile || "");
  if (!inside(root, file)) fail("Go worker binary must be beneath the manifest directory.", "GO_WORKER_PATH_ESCAPE");
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail("Go worker binary is missing.", "GO_WORKER_BINARY_MISSING");
  const relativePath = path.relative(root, file).replaceAll("\\", "/");
  normalizedRelativePath(relativePath, "binary.relativePath");
  const normalizedOperations = [...operations].sort(compareText);
  if (normalizedOperations.length === 0 || new Set(normalizedOperations).size !== normalizedOperations.length
    || normalizedOperations.some((operation) => !OPERATION_PATTERN.test(operation))) fail("Go worker operations are invalid.", "INVALID_GO_WORKER_MANIFEST");
  return validateGoWorkerManifest(withManifestIdentity(manifestPayload({
    target: { platform: target.platform, arch: target.arch, directory: target.directory },
    binary: {
      relativePath,
      sha256: digest(fs.readFileSync(file)),
      size: stat.size,
    },
    operations: normalizedOperations,
  })), { platform, arch });
}

export function validateGoWorkerManifest(manifest, { platform = process.platform, arch = process.arch } = {}) {
  assertFields(manifest, ["schemaVersion", "kind", "manifestVersion", "workerProtocolVersion", "target", "binary", "operations", "processModel", "authority", "manifestId", "manifestHash"], "Go worker manifest");
  const target = targetFor(platform, arch, manifest.kind === "HeadAgentWorkerManifest");
  assertFields(manifest.target, ["platform", "arch", "directory"], "Go worker manifest target");
  assertFields(manifest.binary, ["relativePath", "sha256", "size"], "Go worker manifest binary");
  assertFields(manifest.processModel, ["stdio", "descendants", "network", "projectWrites"], "Go worker manifest process model");
  assertFields(manifest.authority, ["kind", "instructionAuthority", "promotionAuthority", "controlAuthority", "mutatesProject", "mutatesCanon"], "Go worker manifest authority");
  if (manifest.schemaVersion !== 1 || !["HeadAgentWorkerManifest", "LodeAgentWorkerManifest"].includes(manifest.kind) || manifest.manifestVersion !== GO_WORKER_MANIFEST_VERSION
    || manifest.workerProtocolVersion !== WORKER_PROTOCOL_VERSION
    || canonicalJson(manifest.target) !== canonicalJson({ platform: target.platform, arch: target.arch, directory: target.directory })) {
    fail("Go worker manifest target or protocol is incompatible.", "GO_WORKER_MANIFEST_INCOMPATIBLE");
  }
  normalizedRelativePath(manifest.binary.relativePath, "binary.relativePath");
  if (manifest.binary.relativePath !== target.executable || !HASH_PATTERN.test(manifest.binary.sha256)
    || !Number.isInteger(manifest.binary.size) || manifest.binary.size < 1) fail("Go worker binary identity is invalid.", "INVALID_GO_WORKER_MANIFEST");
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0
    || canonicalJson([...manifest.operations].sort(compareText)) !== canonicalJson(manifest.operations)
    || new Set(manifest.operations).size !== manifest.operations.length
    || manifest.operations.some((operation) => !OPERATION_PATTERN.test(operation))) fail("Go worker operations are invalid.", "INVALID_GO_WORKER_MANIFEST");
  if (canonicalJson(manifest.processModel) !== canonicalJson({
    stdio: "single-request-single-response-json", descendants: "forbidden", network: "forbidden", projectWrites: "forbidden",
  }) || canonicalJson(manifest.authority) !== canonicalJson({
    kind: "computation-only", instructionAuthority: false, promotionAuthority: false, controlAuthority: false, mutatesProject: false, mutatesCanon: false,
  })) fail("Go worker process or authority contract is invalid.", "INVALID_GO_WORKER_MANIFEST");
  const payload = { ...manifest };
  delete payload.manifestId;
  delete payload.manifestHash;
  const expected = withManifestIdentity(payload);
  if (expected.manifestId !== manifest.manifestId || expected.manifestHash !== manifest.manifestHash) fail("Go worker manifest digest verification failed.", "GO_WORKER_MANIFEST_DIGEST_MISMATCH");
  return manifest;
}

export function defaultGoWorkerManifestPath({ pluginRoot = ".", platform = process.platform, arch = process.arch } = {}) {
  const target = targetFor(platform, arch);
  return path.join(path.resolve(pluginRoot), "dist", target.directory, "WORKER-MANIFEST.json");
}

export function resolveVerifiedGoWorker({ pluginRoot = ".", manifestFile = null, platform = process.platform, arch = process.arch } = {}) {
  const root = path.resolve(pluginRoot);
  const manifestPath = path.resolve(manifestFile || defaultGoWorkerManifestPath({ pluginRoot: root, platform, arch }));
  if (!inside(root, manifestPath)) fail("Go worker manifest must be beneath the plugin root.", "GO_WORKER_PATH_ESCAPE");
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat) fail("Go worker manifest is not installed.", "GO_WORKER_NOT_AVAILABLE");
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("Go worker manifest must be a regular non-symlink file.", "GO_WORKER_MANIFEST_UNSAFE");
  const realRoot = fs.realpathSync.native(root);
  const realManifest = fs.realpathSync.native(manifestPath);
  if (!inside(realRoot, realManifest)) fail("Go worker manifest resolves outside the plugin distribution root.", "GO_WORKER_PATH_ESCAPE");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("Go worker manifest is not valid JSON.", "INVALID_GO_WORKER_MANIFEST", { cause: error.message });
  }
  validateGoWorkerManifest(manifest, { platform, arch });
  const manifestDirectory = path.dirname(manifestPath);
  const expectedTarget = targetFor(platform, arch);
  if (path.basename(manifestDirectory) !== expectedTarget.directory) fail("Go worker manifest is not in its target distribution directory.", "GO_WORKER_PATH_ESCAPE");
  const binaryPath = path.resolve(manifestDirectory, ...manifest.binary.relativePath.split("/"));
  if (!inside(root, binaryPath) || !inside(manifestDirectory, binaryPath)) fail("Go worker binary escapes the plugin distribution root.", "GO_WORKER_PATH_ESCAPE");
  const binaryStat = fs.lstatSync(binaryPath, { throwIfNoEntry: false });
  if (!binaryStat?.isFile() || binaryStat.isSymbolicLink()) fail("Go worker binary is missing or unsafe.", "GO_WORKER_BINARY_MISSING");
  const realBinary = fs.realpathSync.native(binaryPath);
  if (!inside(realRoot, realBinary)) fail("Go worker binary resolves outside the plugin distribution root.", "GO_WORKER_PATH_ESCAPE");
  if (platform !== "win32" && (binaryStat.mode & 0o111) === 0) fail("Go worker binary is not executable.", "GO_WORKER_BINARY_NOT_EXECUTABLE");
  const bytes = fs.readFileSync(binaryPath);
  if (bytes.length !== manifest.binary.size || digest(bytes) !== manifest.binary.sha256) fail("Go worker binary integrity verification failed.", "GO_WORKER_BINARY_DIGEST_MISMATCH");
  return Object.freeze({
    manifest,
    manifestPath,
    binaryPath,
    workerRelativePath: path.relative(root, binaryPath).replaceAll("\\", "/"),
  });
}

export function createWorkerHealthReferenceAdapter() {
  return new JsReferenceComputeAdapter({
    name: "worker-health-javascript-reference",
    operations: {
      [WORKER_HEALTH_OPERATION]: (input) => {
        if (![canonicalJson(WORKER_HEALTH_INPUT), canonicalJson({ probe: "lode-agent-core" })].includes(canonicalJson(input))) fail("Worker health input is invalid.", "INVALID_WORKER_HEALTH_INPUT");
        return {
          kind: "WorkerHealthResult",
          status: "ready",
          instructionAuthority: false,
          promotionAuthority: false,
          controlAuthority: false,
        };
      },
    },
  });
}

function minimalWorkerEnvironment() {
  const environment = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (typeof process.env[name] === "string" && process.env[name]) environment[name] = process.env[name];
  }
  environment.LANG = "C";
  return environment;
}

function terminateOwnedChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The close/error event remains the lifecycle authority.
  }
  const escalation = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/error event remains the lifecycle authority.
      }
    }
  }, 250);
  escalation.unref?.();
}

async function invokeWorker(selection, request, { signal = null, onProcessStart = null, onProcessEnd = null } = {}) {
  validateComputeRequest(request);
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let settled = false;
    let terminationError = null;
    let workerPid = null;
    let abort = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const rejectCode = (message, code, details = null) => {
      const error = new Error(message);
      error.code = code;
      if (details) error.details = details;
      finish(reject, error);
    };
    const terminateThenReject = (message, code, details = null) => {
      if (settled || terminationError) return;
      terminationError = new Error(message);
      terminationError.code = code;
      if (details) terminationError.details = details;
      terminateOwnedChild(child);
    };
    let child;
    try {
      child = spawn(selection.binaryPath, [], {
        cwd: path.dirname(selection.binaryPath),
        env: minimalWorkerEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectCode("Go worker process could not start.", "GO_WORKER_SPAWN_FAILED", { workerPid, cause: error.message });
      return;
    }
    workerPid = child.pid || null;
    abort = () => {
      const reasonCode = typeof signal?.reason?.code === "string" ? signal.reason.code : "COMPUTE_CANCELLED";
      terminateThenReject("Go worker execution was cancelled.", reasonCode, { workerPid });
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => {
      workerPid = child.pid || workerPid;
      onProcessStart?.(workerPid);
    });
    child.once("error", (error) => rejectCode("Go worker process could not start.", "GO_WORKER_SPAWN_FAILED", { workerPid, cause: error.message }));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.limits.maxOutputBytes + 1) {
        terminateThenReject("Go worker stdout exceeded maxOutputBytes.", "GO_WORKER_STDOUT_LIMIT", { workerPid });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        terminateThenReject("Go worker stderr exceeded its hard limit.", "GO_WORKER_STDERR_LIMIT", { workerPid });
        return;
      }
      stderr.push(chunk);
    });
    child.once("close", (code, closeSignal) => {
      onProcessEnd?.(workerPid);
      if (settled) return;
      if (terminationError) {
        finish(reject, terminationError);
        return;
      }
      if (code !== 0) {
        rejectCode("Go worker exited before returning a valid response.", "GO_WORKER_CRASHED", {
          workerPid,
          exitCode: code,
          signal: closeSignal || "",
          stderrDigest: digest(Buffer.concat(stderr)),
        });
        return;
      }
      let response;
      try {
        const text = Buffer.concat(stdout).toString("utf8").trim();
        response = JSON.parse(text);
        validateComputeResponse(request, response);
      } catch (error) {
        rejectCode("Go worker returned a protocol-invalid response.", "GO_WORKER_RESPONSE_INVALID", { workerPid, cause: error.message });
        return;
      }
      finish(resolve, { response, workerPid });
    });
    child.stdin.on("error", (error) => terminateThenReject("Go worker stdin failed.", "GO_WORKER_STDIN_FAILED", { workerPid, cause: error.message }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function operationalDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Go worker diagnostics are invalid.", "INVALID_GO_WORKER_DIAGNOSTICS");
  const unexpected = Object.keys(value).filter((key) => !DIAGNOSTIC_FIELDS.has(key));
  if (unexpected.length) fail("Go worker diagnostics contain unsupported fields.", "INVALID_GO_WORKER_DIAGNOSTICS");
  return Object.freeze({ ...value });
}

export class GoWorkerComputeAdapter {
  #fallback;
  #fallbackDescriptor;
  #selection;
  #selectionError;
  #diagnostics = new Map();
  #activePids = new Set();

  constructor({ pluginRoot = ".", manifestFile = null, platform = process.platform, arch = process.arch, fallbackAdapter = createWorkerHealthReferenceAdapter(), storage = null } = {}) {
    this.#fallback = fallbackAdapter;
    this.#fallbackDescriptor = validateComputeAdapter(fallbackAdapter);
    try {
      this.#selection = resolveVerifiedGoWorker({ pluginRoot, manifestFile, platform, arch });
      if (formatForVerifiedOwner(storage).dialect === "lode" && this.#selection.manifest.kind !== "LodeAgentWorkerManifest") {
        fail("Installed worker does not support the required Lode family.", "GO_WORKER_NOT_AVAILABLE");
      }
      this.#selectionError = null;
    } catch (error) {
      this.#selection = null;
      this.#selectionError = error;
    }
  }

  describe({ storage = null } = {}) {
    const operations = new Set(this.#fallbackDescriptor.supportedOperations);
    const nativeCompatible = formatForVerifiedOwner(storage).dialect !== "lode" || this.#selection?.manifest.kind === "LodeAgentWorkerManifest";
    for (const operation of nativeCompatible ? this.#selection?.manifest.operations || [] : []) operations.add(operation);
    return {
      contractVersion: COMPUTE_ADAPTER_CONTRACT_VERSION,
      backend: "go-worker-preferred",
      name: "go-worker-with-javascript-fallback",
      executionMode: "verified-stdio-or-in-process-fallback",
      supportedOperations: [...operations].sort(compareText),
      semanticIdentity: "backend-neutral-canonical-output",
      authority: "computation-only",
      instructionAuthority: false,
      promotionAuthority: false,
      controlAuthority: false,
      mutatesProject: false,
      mutatesCanon: false,
      fallback: "javascript-reference-disclosed",
    };
  }

  async #executeFallback(request, signal, reasonCode, workerPid = null, outputRetryToken = null) {
    if (!this.#fallbackDescriptor.supportedOperations.includes(request.operation)) {
      fail(`Neither Go worker nor fallback supports ${request.operation}.`, "UNSUPPORTED_COMPUTE_OPERATION");
    }
    const response = await this.#fallback.execute(request, { signal, outputRetryToken });
    this.#diagnostics.set(request.requestId, operationalDiagnostics({
      backend: this.#fallbackDescriptor.backend,
      adapterName: this.#fallbackDescriptor.name,
      executionMode: this.#fallbackDescriptor.executionMode,
      fallbackUsed: true,
      fallbackReasonCode: reasonCode,
      workerPid,
      workerRelativePath: this.#selection?.workerRelativePath || "",
      workerSha256: this.#selection?.manifest.binary.sha256 || "",
    }));
    return response;
  }

  async execute(request, { signal = null, outputRetryToken = null } = {}) {
    validateComputeRequest(request);
    if (!this.#selection || !this.#selection.manifest.operations.includes(request.operation)) {
      return this.#executeFallback(request, signal, this.#selectionError?.code || "GO_WORKER_OPERATION_NOT_INSTALLED", null, outputRetryToken);
    }
    if (this.#selection.manifest.kind === "HeadAgentWorkerManifest" && request.protocol.name !== "head-agent-core-worker-protocol") {
      return this.#executeFallback(request, signal, "GO_WORKER_FAMILY_NOT_INSTALLED", null, outputRetryToken);
    }
    try {
      const executed = await invokeWorker(this.#selection, request, {
        signal,
        onProcessStart: (pid) => { if (Number.isInteger(pid)) this.#activePids.add(pid); },
        onProcessEnd: (pid) => { if (Number.isInteger(pid)) this.#activePids.delete(pid); },
      });
      this.#diagnostics.set(request.requestId, operationalDiagnostics({
        backend: "go-worker",
        adapterName: "verified-go-worker",
        executionMode: "bounded-stdio-single-request",
        fallbackUsed: false,
        fallbackReasonCode: "",
        workerPid: executed.workerPid,
        workerRelativePath: this.#selection.workerRelativePath,
        workerSha256: this.#selection.manifest.binary.sha256,
      }));
      return executed.response;
    } catch (error) {
      if (!signal?.aborted && RECOVERABLE_NATIVE_CODES.has(error.code)) {
        return this.#executeFallback(request, signal, error.code, error.details?.workerPid || null, outputRetryToken);
      }
      throw error;
    }
  }

  consumeExecutionDiagnostics(requestId) {
    const value = this.#diagnostics.get(requestId) || null;
    this.#diagnostics.delete(requestId);
    return value;
  }

  activeProcessIds() {
    return [...this.#activePids].sort((left, right) => left - right);
  }
}
