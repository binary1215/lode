import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { prepareStructuralRelationObservationEnvelope } from "./structural-relation-observation-envelope.mjs";

export const PYTHON_SOURCE_PROFILE = "python-ast-direct-name-1";
export const sourceDigest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const sourceObjectDigest = (value) => sourceDigest(JSON.stringify(value));
const workerPath = fileURLToPath(new URL("../python-source-worker.py", import.meta.url));
const modulePath = fileURLToPath(import.meta.url);
export const sourceError = (code) => Object.assign(new Error(code), { code });

// All reads, including retained evidence, use the same relative-path boundary.
export function readSourceBytes(root, relative, maxBytes = 1_048_576) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":")
    || relative.split("/").some((part) => !part || part === "." || part === "..")) throw sourceError("SOURCE_PATH_INVALID");
  const canonicalRoot = fs.realpathSync(root);
  let target = canonicalRoot;
  for (const part of relative.split("/")) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) throw sourceError("SOURCE_SYMLINK_UNSUPPORTED");
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw sourceError("SOURCE_NOT_REGULAR_FILE");
    if (before.size > maxBytes) throw sourceError("SOURCE_BYTE_LIMIT");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break;
      count += size;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(target);
    if (named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino
      || before.size !== count || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || fs.realpathSync(target) !== target) throw sourceError("SOURCE_DRIFT");
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

export function sourceCurrent(root, sources) {
  return sources.every((source) => sourceDigest(readSourceBytes(root, source.path)) === source.digest);
}

export function pythonExecutable() {
  const configured = [process.env.LODE_PYTHON, process.env.HEAD_PYTHON].filter(Boolean).map((value) => {
    if (!path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) throw sourceError("PYTHON_NOT_CONFIGURED");
    return fs.realpathSync(value);
  });
  if (configured.length === 2 && configured[0] !== configured[1]) throw sourceError("PYTHON_CONFIGURATION_CONFLICT");
  if (configured.length) return configured[0];
  for (const name of process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory) || /[\\/]WindowsApps(?:[\\/]|$)/i.test(directory)) continue;
      const candidate = path.join(directory, name);
      try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch { /* next PATH entry */ }
    }
  }
  throw sourceError("PYTHON_NOT_CONFIGURED");
}

export function collectorImplementation() {
  return { worker: sourceDigest(fs.readFileSync(workerPath)), normalizer: sourceDigest(fs.readFileSync(modulePath)),
    envelope: sourceDigest(fs.readFileSync(new URL("./structural-relation-observation-envelope.mjs", import.meta.url))),
    observation: sourceDigest(fs.readFileSync(new URL("./source-observation.mjs", import.meta.url))) };
}

// The packaged worker never spawns children. It cannot import/execute project
// files (-I -S, neutral cwd); lifecycle evidence is P5 and never stored in P3.
export async function runPythonSourceWorker(request, { signal, timeoutMs = 15_000, onProcess = () => {} } = {}) {
  if (signal?.aborted) throw sourceError("SOURCE_CANCELLED");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw sourceError("SOURCE_TIMEOUT_INVALID");
  const executable = pythonExecutable();
  const args = ["-I", "-S", "-B", workerPath];
  const frame = Buffer.from(JSON.stringify(request));
  if (frame.length > 12 * 1024 * 1024) throw sourceError("SOURCE_BYTE_LIMIT");
  const lifecycle = { parentPid: process.pid, command: [executable, ...args], cwd: os.tmpdir(), ports: [], pid: null };
  onProcess({ ...lifecycle, event: "planned" });
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: lifecycle.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    lifecycle.pid = child.pid ?? null;
    let failure = null, outputSize = 0, errorSize = 0, timer, forceTimer;
    const output = [], stderr = [];
    const stop = (code) => {
      failure ??= sourceError(code);
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const abort = () => stop("SOURCE_CANCELLED");
    child.once("spawn", () => { onProcess({ ...lifecycle, event: "started" }); if (signal?.aborted) abort(); });
    child.on("error", (error) => { failure ??= sourceError(error.code === "ENOENT" ? "PYTHON_NOT_CONFIGURED" : "SOURCE_PROCESS_FAILED"); });
    child.stdin.on("error", () => { /* close/error below owns settlement */ });
    child.stdout.on("data", (data) => { outputSize += data.length; if (outputSize > 1_048_576) stop("SOURCE_RESPONSE_LIMIT"); else output.push(data); });
    child.stderr.on("data", (data) => { errorSize += data.length; if (errorSize > 1_048_576) stop("SOURCE_RESPONSE_LIMIT"); else stderr.push(data); });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener("abort", abort);
      onProcess({ ...lifecycle, event: "closed", exitCode: code, signal: terminationSignal });
      if (failure) return reject(failure);
      if (code !== 0) return reject(Object.assign(sourceError("SOURCE_PROCESS_FAILED"), { diagnostic: Buffer.concat(stderr).toString("utf8").slice(0, 4096) }));
      const raw = Buffer.concat(output);
      try {
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (result.protocol !== PYTHON_SOURCE_PROFILE || result.profile?.version !== PYTHON_SOURCE_PROFILE
          || result.profile.isolated !== true || result.profile.noSite !== true) throw sourceError("SOURCE_RESPONSE_INVALID");
        resolve({ result, raw, executableDigest: sourceDigest(fs.readFileSync(executable)) });
      } catch { reject(sourceError("SOURCE_RESPONSE_INVALID")); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("SOURCE_TIMEOUT"), timeoutMs);
    child.stdin.end(frame);
  });
}

export function preparePythonObservation({ projectId, query, sources, response, profile }) {
  if (!response?.result?.profile || response.result.protocol !== PYTHON_SOURCE_PROFILE || sourceObjectDigest(response.result.profile) !== sourceObjectDigest(profile.runtime)) throw sourceError("SOURCE_RESPONSE_INVALID");
  const rawKey = "response";
  const sourceBytesByPath = new Map(sources.map((source) => [source.path, Buffer.from(source.base64, "base64")]));
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const endpoints = (endpoint, file) => ({ ...endpoint, path: file.path, digest: file.digest });
  const pairs = new Map();
  const results = response.result.results;
  if (!Array.isArray(results) || results.length !== query.length) throw sourceError("SOURCE_RESPONSE_INVALID");
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index], need = query[index];
    if (!result || typeof result !== "object" || result.path !== need.path || result.symbol !== need.symbol || !Array.isArray(result.pairs) || !Array.isArray(result.unresolved)) throw sourceError("SOURCE_RESPONSE_INVALID");
    const file = byPath.get(result.path);
    for (const pair of result.pairs) {
      if (!pair || typeof pair !== "object" || !pair.from || !pair.to) throw sourceError("SOURCE_RESPONSE_INVALID");
      const from = endpoints(pair.from, file), to = endpoints(pair.to, file);
      const key = sourceObjectDigest({ from, to });
      if (!pairs.has(key)) pairs.set(key, { pairKey: key, type: "CALLS", from, to, language: "python", occurrences: [] });
      const occurrenceKey = sourceObjectDigest({ key, range: pair.range });
      const entry = pairs.get(key);
      if (!entry.occurrences.some((occurrence) => occurrence.occurrenceKey === occurrenceKey)) entry.occurrences.push({
        occurrenceKey, evidence: { path: file.path, digest: file.digest, range: pair.range }, supports: [{ runKey: "collect", rawRefKey: rawKey }],
      });
    }
  }
  const draft = {
    projectId,
    sourceManifest: sources.map((source) => ({ path: source.path, language: "python" })),
    producerClaims: [{ producerClaimKey: "python", name: "python-stdlib-ast-observer", version: profile.runtime.python,
      executableIdentity: profile.executableDigest, profileIdentity: sourceObjectDigest(profile), reportedTransport: "isolated-stdio",
      reportedMethod: "python-ast-direct-name-candidates", analysisMethodClaim: { reportedValue: "static-syntax-lexical-binding-candidate", reportSource: "observer-recorded", truthStatus: "unknown" }, producerIdentityEvidenceStatus: "partial" }],
    rawRefs: [{ rawRefKey: rawKey, kind: "python-ast-response", mediaType: "application/json" }],
    runs: [{ runKey: "collect", producerClaimKey: "python", inputBinding: { sourceManifestScope: "full", configDigest: sourceObjectDigest(query), profileDigest: sourceObjectDigest(profile), normalizerVersion: PYTHON_SOURCE_PROFILE, normalizerImplementationDigest: profile.implementation.normalizer },
      coverage: { admittedSources: sources.map(({ path, digest }) => ({ path, digest })), queriedDirection: "outgoing",
        queriedSymbols: query.map((need) => ({ path: need.path, digest: byPath.get(need.path).digest, name: need.symbol.split(".").at(-1), symbolKind: "function", line: results.find((result) => result.path === need.path && result.symbol === need.symbol)?.pairs[0]?.from.selectionRange.start.line ?? 0 })),
        reportedResponseClosure: "complete-frame-observed", programCoverage: "unknown", repositoryRelationCompleteness: "not-claimed" }, rawRefKeys: [rawKey] }],
    pairs: [...pairs.values()], diagnosticLabels: ["parse-only-python", "positive-lexical-candidates-not-runtime-truth", "unresolved-calls-preserved-in-raw-response"],
  };
  return { draft, ...prepareStructuralRelationObservationEnvelope(draft, { sourceBytesByPath, rawBytesById: new Map([[rawKey, response.raw]]) }) };
}

export const PYTHON_DECLARATION_KINDS = Object.freeze(["declarations", "selected-source"]);
// Diagnostic provenance, not a capability gate or claim of parse success.
// The digest binds the complete profile; paths, raw frames and file bytes stay private.
export function compactDeclarationProfile(profile) {
  if (!profile?.runtime) return null;
  return { producer: "python-stdlib-ast", declarationProtocol: "python-static-declarations-1",
    workerProtocol: profile.runtime.version, pythonVersion: String(profile.runtime.python ?? "").split(/\s/u)[0].slice(0, 32),
    implementation: String(profile.runtime.implementation ?? "").slice(0, 32),
    isolated: profile.runtime.isolated === true, noSite: profile.runtime.noSite === true,
    profileDigest: sourceObjectDigest(profile), workerDigest: profile.implementation?.worker ?? null,
    normalizerDigest: profile.implementation?.normalizer ?? null,
    basis: "verified-worker-identity; not-parse-success-or-runtime-truth" };
}
const declarationKinds = ["class", "function", "async-function", "method", "async-method"];
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));
const pointValid = (p) => closed(p, ["line", "character"]) && Number.isSafeInteger(p.line) && p.line >= 0
  && Number.isSafeInteger(p.character) && p.character >= 0;
const rangeValid = (r) => closed(r, ["start", "end"]) && pointValid(r.start) && pointValid(r.end);
export function validateDeclarationSelection(selection) {
  if (!closed(selection, ["path", "fileDigest", "qualifiedName", "kind", "occurrence", "range"])
    || typeof selection.path !== "string" || !selection.path || selection.path.length > 512
    || !/^[a-f0-9]{64}$/.test(selection.fileDigest ?? "") || typeof selection.qualifiedName !== "string"
    || !selection.qualifiedName || selection.qualifiedName.length > 512 || !declarationKinds.includes(selection.kind)
    || !Number.isSafeInteger(selection.occurrence) || selection.occurrence < 1 || !rangeValid(selection.range)) throw sourceError("SOURCE_NEEDS_INVALID");
  return selection;
}

// JS string offsets are UTF-16. Never normalize newlines, whitespace or literals.
export function exactDeclarationSlice(text, range) {
  if (!rangeValid(range)) throw sourceError("SOURCE_RESPONSE_INVALID");
  const lines = text.split("\n");
  const offset = (point) => {
    const line = lines[point.line];
    if (line === undefined || point.character > line.length
      || (point.character > 0 && /[\uD800-\uDBFF]/u.test(line[point.character - 1])
        && /[\uDC00-\uDFFF]/u.test(line[point.character] ?? ""))) throw sourceError("SOURCE_RESPONSE_INVALID");
    return lines.slice(0, point.line).reduce((sum, entry) => sum + entry.length + 1, 0) + point.character;
  };
  const start = offset(range.start), end = offset(range.end);
  if (end <= start) throw sourceError("SOURCE_RESPONSE_INVALID");
  return { text: text.slice(start, end), start, end };
}

export function preparePythonDeclarations({ query, sources, response, profile }) {
  const invalid = () => { throw sourceError("SOURCE_RESPONSE_INVALID"); };
  if (response.result?.protocol !== PYTHON_SOURCE_PROFILE || sourceObjectDigest(response.result.profile) !== sourceObjectDigest(profile.runtime)
    || !Array.isArray(response.result.results) || response.result.results.length !== 1 || query.length !== 1 || sources.length !== 1) invalid();
  const result = response.result.results[0], need = query[0], file = sources[0];
  if (!closed(result, ["path", "symbol", "kind", "status", "declarationProtocol", "total", "omitted", "declarations", "errorType"])
    || result.path !== need.path || result.symbol !== need.symbol || result.kind !== need.kind
    || !PYTHON_DECLARATION_KINDS.includes(need.kind) || result.declarationProtocol !== "python-static-declarations-1"
    || !["ready", "partial", "ambiguous", "missing", "stale-selection", "selection-mismatch", "parse-unsupported"].includes(result.status)
    || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.omitted) || result.omitted < 0
    || !Array.isArray(result.declarations) || result.declarations.length > 64 || result.total !== result.declarations.length + result.omitted) invalid();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.base64, "base64"));
  const seen = new Set();
  const declarations = result.declarations.map((item) => {
    if (!closed(item, ["qualifiedName", "kind", "scope", "occurrence", "conditional", "decorated", "range", "headerRange", "nameRange"])
      || typeof item.qualifiedName !== "string" || !item.qualifiedName || item.qualifiedName.length > 512
      || typeof item.scope !== "string" || !declarationKinds.includes(item.kind) || !Number.isSafeInteger(item.occurrence) || item.occurrence < 1
      || typeof item.conditional !== "boolean" || typeof item.decorated !== "boolean") invalid();
    const source = exactDeclarationSlice(text, item.range), header = exactDeclarationSlice(text, item.headerRange), name = exactDeclarationSlice(text, item.nameRange);
    if (header.start < source.start || header.end > source.end || name.start < header.start || name.end > header.end
      || name.text.normalize("NFKC") !== item.qualifiedName.split(".").at(-1)
      || !/^(?:(?:class|def)(?:\s|\\\r?\n)|async(?:\s|\\\r?\n)+def(?:\s|\\\r?\n))/u.test(header.text)
      || !header.text.endsWith(":") || (item.decorated ? !source.text.startsWith("@") : header.start !== source.start)
      || (need.kind === "selected-source" && item.qualifiedName !== need.symbol)) invalid();
    const selection = { path: file.path, fileDigest: file.digest, qualifiedName: item.qualifiedName, kind: item.kind, occurrence: item.occurrence, range: item.range };
    const key = sourceObjectDigest(selection);
    if (seen.has(key)) invalid(); seen.add(key);
    if (need.selection) {
      const chosen = validateDeclarationSelection(need.selection);
      if (["path", "fileDigest", "qualifiedName", "kind", "occurrence"].some((key) => chosen[key] !== selection[key])
        || ["start", "end"].some((key) => chosen.range[key].line !== item.range[key].line || chosen.range[key].character !== item.range[key].character)) invalid();
    }
    const display = header.text.replace(/\s+/gu, " ");
    const signature = display.slice(0, 500).replace(/[\uD800-\uDBFF]$/u, "");
    return { ...item, selection, displaySignature: signature, displaySignatureTruncated: display.length > signature.length };
  });
  if ((result.status === "ready" && (result.omitted !== 0 || (need.kind === "selected-source" && declarations.length !== 1)))
    || (result.status === "partial" && (need.kind !== "declarations" || result.omitted === 0))
    || (result.status === "ambiguous" && (need.kind !== "selected-source" || result.total < 2))
    || (["missing", "stale-selection", "selection-mismatch", "parse-unsupported"].includes(result.status) && result.total !== 0)) invalid();
  let status = result.status;
  const details = { claimTruth: "unknown", repositoryCompleteness: "not-claimed", staticDeclarationsOnly: true,
    collectionProfile: compactDeclarationProfile(profile),
    status, total: result.total, omitted: result.omitted, declarations };
  if (need.kind === "selected-source" && status === "ready") {
    const source = exactDeclarationSlice(text, declarations[0].range).text;
    details.selectedSourceBytes = Buffer.byteLength(source);
    if (Buffer.byteLength(source) > 48_000) status = "source-too-large";
    else details.source = source;
  }
  // Keep the existing common Observation string bound, with explicit omissions.
  while (Buffer.byteLength(JSON.stringify(details)) > 60_000 && details.declarations.length) {
    details.declarations.pop(); details.omitted += 1;
    status = need.kind === "declarations" ? "partial" : status === "ready" ? "source-too-large" : status;
    delete details.source;
  }
  details.status = status;
  return { status: ["ready", "partial"].includes(status) ? "ready" : status, code: `SOURCE_DECLARATION_${status.toUpperCase().replaceAll("-", "_")}`,
    details, evidenceHash: sourceObjectDigest(details) };
}
