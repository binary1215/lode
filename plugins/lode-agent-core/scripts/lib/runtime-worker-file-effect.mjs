import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";

export const WORKER_FILE_EFFECT_PROTOCOL_VERSION = "0.1.0";
export const WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES = 8 * 1024 * 1024;
const defaultPluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const imageOperations = new Set(["image-preflight", "image-apply", "image-inspect", "image-retry"]);
const operations = new Set(["probe", "inspect", "edit", "retry", ...imageOperations]);
const validDigest = (value, empty = false) => typeof value === "string" && (empty && value === "" || /^[a-f0-9]{64}$/.test(value));
const imageDigest = (image) => hash(JSON.stringify(image.kind === "absent" ? { kind: "absent" } : { kind: "file", content: image.content, mode: image.mode }));
const imageOperation = ({ before, after }) => before.kind === "absent" ? "create" : after.kind === "absent" ? "delete" : before.content === after.content ? "mode" : "edit";
const nativeErrorCodes = new Set(["BUSY", "CONFLICT", "UNSUPPORTED", "ALREADY_EXISTS", "NOT_FOUND", "ACCESS_DENIED", "IO_ERROR",
  "INVALID_REQUEST", "INVALID_PAYLOAD", "REQUEST_LIMIT", "RESPONSE_LIMIT", "PAYLOAD_DIGEST", "INPUT_IO"].map((name) => `FILE_EFFECT_${name}`));
const preparedInvocations = new WeakMap();
const liveTerminalProofs = new WeakMap();
const validRequestId = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const supervisorTargets = new Map([ ["win32-x64", "windows-x64"], ["darwin-arm64", "darwin-arm64"], ["darwin-x64", "darwin-x64"],
  ["linux-arm64", "linux-arm64"], ["linux-x64", "linux-x64"] ]);
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function workerFileEffectCanonicalEffectDigest(effect) { jsonValue(effect); return hash(canonicalJson(effect)); }
export function workerFileEffectNativeIntentId(effect) {
  const image = (value) => value.kind === "absent" ? { kind: "absent" } : { kind: "file", content: value.content, mode: value.mode };
  const canonical = { root: effect.root.toWellFormed(), rootIdentity: effect.rootIdentity.toWellFormed(),
    ancestorIdentities: effect.ancestorIdentities.map((value) => value.toWellFormed()), path: effect.path.toWellFormed(),
    before: image(effect.before), after: image(effect.after), maxBytes: effect.maxBytes };
  if (effect.previousIntentId) canonical.previousIntentId = effect.previousIntentId.toWellFormed();
  // Go's encoding/json escapes HTML and line separators in addition to JSON's
  // normal escaping. Bind the exact native intent, not a JS look-alike hash.
  const encoded = JSON.stringify(canonical).replace(/[<>&\u2028\u2029]/g, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `file-image-effect-${hash(encoded)}`;
}

function failure(code) {
  // A transport failure is never evidence that a possible file effect did not
  // start. A verified native journal or exact prepublication phase witness
  // still needs Core's current-basis checks before a retry can be considered.
  return Object.assign(new Error(`Worker file-effect transport failed: ${code}.`), { code, effectStatus: "unknown", retrySafe: false });
}
function requireValue(condition, code = "INVALID_WORKER_FILE_EFFECT_RESPONSE") {
  if (!condition) throw failure(code);
}
function fields(value, required, optional = [], code = "INVALID_WORKER_FILE_EFFECT_RESPONSE") {
  requireValue(value && typeof value === "object" && !Array.isArray(value), code);
  requireValue(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), code);
}
function jsonValue(value, depth = 0) {
  requireValue(depth <= 16, "INVALID_WORKER_FILE_EFFECT_REQUEST");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { requireValue(Number.isFinite(value), "INVALID_WORKER_FILE_EFFECT_REQUEST"); return; }
  requireValue(value && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), "INVALID_WORKER_FILE_EFFECT_REQUEST");
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(typeof key === "string" && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "INVALID_WORKER_FILE_EFFECT_REQUEST");
    jsonValue(descriptor.value, depth + 1);
  }
  if (Array.isArray(value)) requireValue(Object.keys(value).length === value.length, "INVALID_WORKER_FILE_EFFECT_REQUEST");
}

function validateImageRequest(operation, payload) {
  const code = "INVALID_WORKER_FILE_EFFECT_REQUEST";
  fields(payload, ["effect", "journal"], [], code);
  const effect = payload.effect;
  fields(effect, ["root", "rootIdentity", "ancestorIdentities", "path", "before", "after", "maxBytes"], ["previousIntentId"], code);
  requireValue(typeof payload.journal === "string" && payload.journal.length > 0 && typeof effect.root === "string" && effect.root.length > 0
    && typeof effect.path === "string" && effect.path.length > 0 && typeof effect.rootIdentity === "string"
    && Array.isArray(effect.ancestorIdentities) && effect.ancestorIdentities.every((item) => typeof item === "string" && item.length > 0)
    && Number.isSafeInteger(effect.maxBytes) && effect.maxBytes >= 0, code);
  const discovery = operation === "image-preflight" && effect.rootIdentity === "" && effect.ancestorIdentities.length === 0;
  requireValue(discovery || effect.rootIdentity.length > 0 && effect.ancestorIdentities.length === effect.path.split("/").length
    && effect.ancestorIdentities[0] === effect.rootIdentity, code);
  requireValue(!Object.hasOwn(effect, "previousIntentId") || typeof effect.previousIntentId === "string"
    && /^file-image-effect-[a-f0-9]{64}$/.test(effect.previousIntentId), code);
  for (const image of [effect.before, effect.after]) {
    fields(image, image?.kind === "absent" ? ["kind"] : ["kind", "content", "mode"], [], code);
    requireValue(image.kind === "absent" || image.kind === "file", code);
    if (image.kind === "file") {
      // Valid but unrepresentable modes belong to capability preflight, not a
      // generic malformed-input gate. The native adapter owns OS semantics.
      requireValue(typeof image.content === "string" && Number.isInteger(image.mode) && image.mode >= 0 && image.mode <= 0o777, code);
      const bytes = Buffer.from(image.content, "base64");
      requireValue(bytes.toString("base64") === image.content && bytes.length <= effect.maxBytes, code);
    }
  }
  requireValue(imageDigest(effect.before) !== imageDigest(effect.after), code);
}

function validateImageResult(response, request) {
  const result = response.result;
  const effect = request.payload.effect;
  const beforeDigest = imageDigest(effect.before);
  const afterDigest = imageDigest(effect.after);
  const validIntent = (value) => typeof value === "string" && (value === "" || /^file-image-effect-[a-f0-9]{64}$/.test(value));
  if (request.operation === "image-preflight") {
    fields(result, ["status", "reason", "operation", "modeSemantics", "metadataCAS", "multiFileAtomic"], ["rootIdentity", "ancestorIdentities"]);
    requireValue(response.status === "ok" && result.operation === imageOperation(effect)
      && result.modeSemantics === "windows-readonly-attribute-only" && result.metadataCAS === false && result.multiFileAtomic === false);
    requireValue(result.status === "supported" && result.reason === "existing-parent-local-ntfs"
      || result.status === "unsupported" && ["platform-unsupported", "missing-parent-directory", "filesystem-not-local-ntfs", "mode-not-representable", "readonly-byte-edit-unsupported"].includes(result.reason));
    if (result.status === "supported" || Object.hasOwn(result, "rootIdentity") || Object.hasOwn(result, "ancestorIdentities")) {
      requireValue(typeof result.rootIdentity === "string" && result.rootIdentity.length > 0 && Array.isArray(result.ancestorIdentities)
        && result.ancestorIdentities.length === effect.path.split("/").length && result.ancestorIdentities.every((value) => typeof value === "string" && value.length > 0)
        && result.ancestorIdentities[0] === result.rootIdentity);
      if (effect.rootIdentity) requireValue(result.rootIdentity === effect.rootIdentity && JSON.stringify(result.ancestorIdentities) === JSON.stringify(effect.ancestorIdentities));
    }
  } else if (request.operation === "image-inspect") {
    fields(result, ["intentId", "status", "startedRecorded", "noWriteRecorded", "completionRecorded", "retryBasisAvailable", "appliedByThisRead"], ["currentImageDigest"]);
    requireValue(validIntent(result.intentId) && ["unknown", "current-ancestor-conflict", "unverifiable-current", "preimage-observed", "postimage-observed", "partial-or-concurrent"].includes(result.status)
      && [result.startedRecorded, result.noWriteRecorded, result.completionRecorded, result.retryBasisAvailable].every((value) => typeof value === "boolean")
      && result.appliedByThisRead === false && (!Object.hasOwn(result, "currentImageDigest") || validDigest(result.currentImageDigest)));
    requireValue(!(response.status === "ok" || result.startedRecorded || result.noWriteRecorded || result.completionRecorded || result.retryBasisAvailable) || result.intentId !== "");
    if (result.status === "preimage-observed") requireValue(result.currentImageDigest === beforeDigest);
    if (result.status === "postimage-observed") requireValue(result.currentImageDigest === afterDigest);
    requireValue(!result.retryBasisAvailable || result.noWriteRecorded && !result.completionRecorded && result.status === "preimage-observed");
    if (response.status === "ok") requireValue(!result.completionRecorded || result.startedRecorded && !result.noWriteRecorded);
  } else {
    fields(result, ["status", "intentId", "beforeImageDigest", "afterImageDigest", "dataFlushed", "metadataCAS", "multiFileAtomic"], ["currentImageDigest", "intentPublication"]);
    requireValue(["not-started", "incomplete-or-conflict", "effect-observed"].includes(result.status) && validIntent(result.intentId)
      && validDigest(result.beforeImageDigest, response.status === "error") && validDigest(result.afterImageDigest, response.status === "error")
      && typeof result.dataFlushed === "boolean" && result.metadataCAS === false && result.multiFileAtomic === false
      && (!Object.hasOwn(result, "currentImageDigest") || validDigest(result.currentImageDigest)));
    if (result.beforeImageDigest) requireValue(result.beforeImageDigest === beforeDigest);
    if (result.afterImageDigest) requireValue(result.afterImageDigest === afterDigest);
    if (response.status === "ok") requireValue(result.status === "effect-observed" && result.intentId !== "" && result.currentImageDigest === afterDigest
      && result.dataFlushed === ["create", "edit"].includes(imageOperation(effect)));
    if (Object.hasOwn(result, "intentPublication")) requireValue(request.operation === "image-apply" && !effect.previousIntentId
      && response.status === "error" && result.status === "not-started" && result.intentPublication === "not-attempted"
      && result.dataFlushed === false && result.intentId === workerFileEffectNativeIntentId(effect)
      && result.beforeImageDigest === beforeDigest && result.afterImageDigest === afterDigest && !Object.hasOwn(result, "currentImageDigest"));
  }
}

// JSON.parse alone silently accepts repeated names. Scan the bounded frame
// first, including escaped names and nested objects; then use the standard
// parser for scalar syntax, Unicode escapes and number grammar.
function parseUniqueJson(bytes) {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw failure("INVALID_WORKER_FILE_EFFECT_RESPONSE"); }
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] || "!") && offset < source.length) offset++; };
  const string = () => {
    requireValue(source[offset] === '"');
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") offset++;
      else if (character === '"') return JSON.parse(source.slice(start, offset));
    }
    throw failure("INVALID_WORKER_FILE_EFFECT_RESPONSE");
  };
  const value = (depth) => {
    requireValue(depth <= 16);
    whitespace();
    if (source[offset] === '"') { string(); return; }
    if (source[offset] === "{" || source[offset] === "[") {
      const object = source[offset++] === "{";
      const end = object ? "}" : "]";
      const seen = new Set();
      whitespace();
      if (source[offset] === end) { offset++; return; }
      for (;;) {
        whitespace();
        if (object) {
          const key = string();
          requireValue(!seen.has(key)); seen.add(key); whitespace();
          requireValue(source[offset++] === ":");
        }
        value(depth + 1); whitespace();
        if (source[offset] === end) { offset++; return; }
        requireValue(source[offset++] === ",");
      }
    }
    const start = offset;
    while (offset < source.length && !/[\x20\t\r\n,}\]]/.test(source[offset])) offset++;
    requireValue(offset > start);
    JSON.parse(source.slice(start, offset));
  };
  try {
    value(0); whitespace(); requireValue(offset === source.length);
    return JSON.parse(source);
  } catch { throw failure("INVALID_WORKER_FILE_EFFECT_RESPONSE"); }
}

function validateResult(response, request) {
  const result = response.result;
  if (result === undefined) { requireValue(response.status === "error"); return; }
  const validIntent = (value) => typeof value === "string" && (value === "" || /^file-effect-[a-f0-9]{64}$/.test(value));
  if (imageOperations.has(request.operation)) {
    validateImageResult(response, request);
  } else if (request.operation === "probe") {
    fields(result, ["rootIdentity", "ancestorIdentities"]);
    requireValue(response.status === "ok" && typeof result.rootIdentity === "string" && result.rootIdentity.length > 0
      && Array.isArray(result.ancestorIdentities) && result.ancestorIdentities.length === request.payload.path.split("/").length
      && result.ancestorIdentities.every((item) => typeof item === "string" && item.length > 0) && result.ancestorIdentities[0] === result.rootIdentity);
  } else if (request.operation === "inspect") {
    fields(result, ["intentId", "status", "startedRecorded", "noWriteRecorded", "completionRecorded", "retryBasisAvailable", "appliedByThisRead"], ["currentDigest"]);
    requireValue(validIntent(result.intentId) && ["unknown", "current-ancestor-conflict", "unverifiable-current", "preimage-observed", "postimage-observed", "partial-or-concurrent"].includes(result.status)
      && [result.startedRecorded, result.noWriteRecorded, result.completionRecorded, result.retryBasisAvailable].every((item) => typeof item === "boolean")
      && result.appliedByThisRead === false && (!Object.hasOwn(result, "currentDigest") || validDigest(result.currentDigest)));
    requireValue(!(response.status === "ok" || result.startedRecorded || result.noWriteRecorded || result.completionRecorded || result.retryBasisAvailable) || result.intentId !== "");
    if (["preimage-observed", "postimage-observed"].includes(result.status)) {
      const basis = result.status === "preimage-observed" ? "before" : "after";
      requireValue(result.currentDigest === hash(Buffer.from(request.payload.edit[basis], "base64")));
    }
    requireValue(!result.retryBasisAvailable || result.noWriteRecorded && !result.completionRecorded && result.status === "preimage-observed");
    // A native error may expose contradictory retained phases for diagnosis;
    // never discard that evidence or reclassify it as a successful inspection.
    if (response.status === "ok") requireValue(!result.completionRecorded || result.startedRecorded && !result.noWriteRecorded);
  } else {
    fields(result, ["status", "intentId", "beforeDigest", "afterDigest", "metadataCAS", "multiFileAtomic"], ["currentDigest"]);
    requireValue(["not-started", "incomplete-or-conflict", "bytes-flushed"].includes(result.status) && validIntent(result.intentId)
      && validDigest(result.beforeDigest, response.status === "error") && validDigest(result.afterDigest, response.status === "error")
      && result.metadataCAS === false && result.multiFileAtomic === false && (!Object.hasOwn(result, "currentDigest") || validDigest(result.currentDigest)));
    for (const key of ["before", "after"]) if (result[`${key}Digest`]) requireValue(result[`${key}Digest`] === hash(Buffer.from(request.payload.edit[key], "base64")));
    if (response.status === "ok") requireValue(result.status === "bytes-flushed" && result.intentId !== "" && result.currentDigest === result.afterDigest);
  }
}
function verifyResponse(bytes, request, requestDigest, exitCode, signal) {
  const response = parseUniqueJson(bytes);
  fields(response, ["protocolVersion", "requestId", "operation", "payloadDigest", "requestDigest", "status", "authorityEffect"], ["result", "error"]);
  requireValue(response.protocolVersion === WORKER_FILE_EFFECT_PROTOCOL_VERSION && response.requestId === request.requestId
    && response.operation === request.operation && response.payloadDigest === request.payloadDigest && response.requestDigest === requestDigest
    && response.authorityEffect === "none" && signal === null);
  requireValue(response.status === "ok" && exitCode === 0 && !Object.hasOwn(response, "error") && Object.hasOwn(response, "result")
    || response.status === "error" && exitCode === 2 && Object.hasOwn(response, "error"));
  if (response.status === "error") { fields(response.error, ["code"]); requireValue(nativeErrorCodes.has(response.error.code)); }
  validateResult(response, request);
  return response;
}
function environment() {
  const allowed = new Set(["systemroot", "windir", "temp", "tmp", "tmpdir"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === "string")), LANG: "C" };
}

function binaryIdentity(selection) {
  const manifest = selection.manifest;
  return { manifestId: manifest.manifestId, manifestHash: manifest.manifestHash, binarySha256: manifest.binary.sha256,
    binarySize: manifest.binary.size, target: { ...manifest.target } };
}
export function verifyWorkerFileEffectBinding(binding, { operation, effect, requestId } = {}) {
  jsonValue(binding);
  fields(binding, ["kind", "protocolVersion", "operation", "requestIdDigest", "requestDigest", "payloadDigest", "canonicalEffectDigest", "expectedNativeIntentId", "binaryIdentity", "bindingDigest"]);
  requireValue(binding.kind === "WorkerFileEffectRequestBinding" && binding.protocolVersion === WORKER_FILE_EFFECT_PROTOCOL_VERSION && operations.has(binding.operation)
    && [binding.requestIdDigest, binding.requestDigest, binding.payloadDigest, binding.bindingDigest].every((value) => validDigest(value)));
  fields(binding.binaryIdentity, ["manifestId", "manifestHash", "binarySha256", "binarySize", "target"]);
  fields(binding.binaryIdentity.target, ["platform", "arch", "directory"]);
  requireValue(/^process-supervisor-manifest-[a-f0-9]{24}$/.test(binding.binaryIdentity.manifestId)
    && validDigest(binding.binaryIdentity.manifestHash) && validDigest(binding.binaryIdentity.binarySha256)
    && binding.binaryIdentity.manifestId === `process-supervisor-manifest-${binding.binaryIdentity.manifestHash.slice(0, 24)}`
    && Number.isSafeInteger(binding.binaryIdentity.binarySize) && binding.binaryIdentity.binarySize > 0
    && Object.values(binding.binaryIdentity.target).every((value) => typeof value === "string")
    && supervisorTargets.get(`${binding.binaryIdentity.target.platform}-${binding.binaryIdentity.target.arch}`) === binding.binaryIdentity.target.directory);
  requireValue(imageOperations.has(binding.operation) ? validDigest(binding.canonicalEffectDigest) && /^file-image-effect-[a-f0-9]{64}$/.test(binding.expectedNativeIntentId)
    : binding.canonicalEffectDigest === null && binding.expectedNativeIntentId === null);
  const { bindingDigest, ...body } = binding;
  requireValue(hash(canonicalJson(body)) === bindingDigest);
  if (operation !== undefined) requireValue(binding.operation === operation);
  if (requestId !== undefined) requireValue(validRequestId(requestId) && binding.requestIdDigest === hash(requestId));
  if (effect !== undefined) requireValue(binding.canonicalEffectDigest === workerFileEffectCanonicalEffectDigest(effect)
    && binding.expectedNativeIntentId === workerFileEffectNativeIntentId(effect));
  return binding;
}
function projectedResponse(response) { const { requestId, ...projection } = response; return projection; }

// Historical verification checks the already-published evidence's exact
// binding. It cannot authenticate a new child or authorize another invocation.
// The live check additionally requires this module's non-serializable witness.
export function verifyWorkerFileEffectTerminalProof(proof, { expectedBinding, expectedResponse, effect, requireLive = false } = {}) {
  jsonValue(proof);
  fields(proof, ["kind", "protocolVersion", "binding", "nativeResponse", "nativeResponseDigest", "rawResponseDigest", "rawResponseByteLength", "exitCode", "signal", "ownedChildClosed", "provenance", "proofDigest"]);
  requireValue(proof.kind === "WorkerFileEffectTerminalProof" && proof.protocolVersion === WORKER_FILE_EFFECT_PROTOCOL_VERSION
    && proof.signal === null && proof.ownedChildClosed === true && ["verified-native-child", "trusted-host-fixture"].includes(proof.provenance)
    && [proof.nativeResponseDigest, proof.rawResponseDigest, proof.proofDigest].every((value) => validDigest(value))
    && Number.isSafeInteger(proof.rawResponseByteLength) && proof.rawResponseByteLength > 0 && proof.rawResponseByteLength <= WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES);
  verifyWorkerFileEffectBinding(proof.binding, effect === undefined ? {} : { effect });
  requireValue(imageOperations.has(proof.binding.operation));
  if (expectedBinding !== undefined) { verifyWorkerFileEffectBinding(expectedBinding); requireValue(canonicalJson(proof.binding) === canonicalJson(expectedBinding)); }
  const live = liveTerminalProofs.get(proof);
  if (requireLive) requireValue(live && live.bindingDigest === proof.binding.bindingDigest && live.rawResponseDigest === proof.rawResponseDigest, "WORKER_FILE_EFFECT_PROOF_NOT_LIVE");
  const response = proof.nativeResponse;
  fields(response, ["protocolVersion", "operation", "payloadDigest", "requestDigest", "status", "authorityEffect"], ["result", "error"]);
  requireValue(response.protocolVersion === proof.binding.protocolVersion && response.operation === proof.binding.operation
    && response.payloadDigest === proof.binding.payloadDigest && response.requestDigest === proof.binding.requestDigest && response.authorityEffect === "none"
    && hash(canonicalJson(response)) === proof.nativeResponseDigest);
  requireValue(response.status === "ok" && proof.exitCode === 0 && !Object.hasOwn(response, "error") && Object.hasOwn(response, "result")
    || response.status === "error" && proof.exitCode === 2 && Object.hasOwn(response, "error"));
  if (response.status === "error") { fields(response.error, ["code"]); requireValue(nativeErrorCodes.has(response.error.code)); }
  const requestEffect = effect ?? live?.effect;
  if (imageOperations.has(response.operation)) {
    requireValue(requestEffect !== undefined, "WORKER_FILE_EFFECT_PROOF_EFFECT_REQUIRED");
    verifyWorkerFileEffectBinding(proof.binding, { effect: requestEffect });
    validateResult(response, { operation: response.operation, payload: { effect: requestEffect } });
  }
  if (expectedResponse !== undefined) {
    jsonValue(expectedResponse);
    requireValue(validRequestId(expectedResponse.requestId) && hash(expectedResponse.requestId) === proof.binding.requestIdDigest
      && canonicalJson(projectedResponse(expectedResponse)) === canonicalJson(response));
  }
  const { proofDigest, ...body } = proof;
  requireValue(hash(canonicalJson(body)) === proofDigest);
  return { binding: proof.binding, response, provenance: proof.provenance, initialIntentNotAttempted:
    response.operation === "image-apply" && response.result?.intentPublication === "not-attempted" };
}

function terminalProof(state, bytes, response, exitCode) {
  if (!imageOperations.has(state.request.operation) || state.spawnImplementation !== spawn && !state.trustedHostFixture) return null;
  const nativeResponse = projectedResponse(response);
  const body = { kind: "WorkerFileEffectTerminalProof", protocolVersion: WORKER_FILE_EFFECT_PROTOCOL_VERSION, binding: state.binding,
    nativeResponse, nativeResponseDigest: hash(canonicalJson(nativeResponse)), rawResponseDigest: hash(bytes), rawResponseByteLength: bytes.length,
    exitCode, signal: null, ownedChildClosed: true, provenance: state.trustedHostFixture ? "trusted-host-fixture" : "verified-native-child" };
  const proof = freeze(JSON.parse(JSON.stringify({ ...body, proofDigest: hash(canonicalJson(body)) })));
  liveTerminalProofs.set(proof, { bindingDigest: state.binding.bindingDigest, rawResponseDigest: proof.rawResponseDigest, effect: state.request.payload.effect });
  return proof;
}

// Internal Host transport, not an authorization or an integration decision.
// The verified native --file-effect branch creates no child processes or
// listeners. Core must bind the journal and revalidate authority before use.
export function prepareWorkerFileEffectInvocation({ operation, payload, requestId = crypto.randomUUID(), maxRequestBytes = WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES,
  maxResponseBytes = 64 * 1024, timeoutMs = 30_000 } = {}, { pluginRoot = defaultPluginRoot, manifestFile = null,
  onProcess = () => {}, spawnImplementation = spawn, trustedHostFixture = false } = {}) {
  requireValue(operations.has(operation) && Number.isSafeInteger(maxRequestBytes) && maxRequestBytes >= 1 && maxRequestBytes <= WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES
    && Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 4096 && maxResponseBytes <= WORKER_FILE_EFFECT_TRANSPORT_MAX_BYTES
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000 && typeof onProcess === "function" && typeof spawnImplementation === "function"
    && typeof trustedHostFixture === "boolean" && validRequestId(requestId), "INVALID_WORKER_FILE_EFFECT_REQUEST");
  jsonValue(payload);
  if (imageOperations.has(operation)) validateImageRequest(operation, payload);
  else fields(payload, operation === "probe" ? ["root", "path"] : ["edit", "journal"], [], "INVALID_WORKER_FILE_EFFECT_REQUEST");
  const payloadJson = JSON.stringify(payload);
  const request = { protocolVersion: WORKER_FILE_EFFECT_PROTOCOL_VERSION, requestId, operation, maxRequestBytes,
    maxResponseBytes, payloadDigest: hash(Buffer.from(payloadJson, "utf8")), payload: JSON.parse(payloadJson) };
  const input = Buffer.from(JSON.stringify(request), "utf8");
  requireValue(input.length <= maxRequestBytes, "WORKER_FILE_EFFECT_REQUEST_LIMIT");
  const requestDigest = hash(input);
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot, manifestFile });
  const body = { kind: "WorkerFileEffectRequestBinding", protocolVersion: WORKER_FILE_EFFECT_PROTOCOL_VERSION, operation,
    requestIdDigest: hash(requestId), requestDigest, payloadDigest: request.payloadDigest,
    canonicalEffectDigest: imageOperations.has(operation) ? workerFileEffectCanonicalEffectDigest(request.payload.effect) : null,
    expectedNativeIntentId: imageOperations.has(operation) ? workerFileEffectNativeIntentId(request.payload.effect) : null, binaryIdentity: binaryIdentity(selection) };
  const binding = freeze({ ...body, bindingDigest: hash(canonicalJson(body)) });
  const capability = Object.freeze({ binding });
  preparedInvocations.set(capability, { binding, request: freeze(request), input, selection, pluginRoot, manifestFile, onProcess, spawnImplementation,
    trustedHostFixture, maxResponseBytes, timeoutMs, requestDigest, used: false });
  return capability;
}

export async function invokeWorkerFileEffect(request, options) {
  const { response } = await invokePreparedWorkerFileEffect(prepareWorkerFileEffectInvocation(request, options));
  return response;
}

export async function invokePreparedWorkerFileEffect(capability) {
  const state = preparedInvocations.get(capability);
  requireValue(state && !state.used, "WORKER_FILE_EFFECT_PREPARED_CAPABILITY_INVALID");
  state.used = true;
  const { request, input, onProcess, spawnImplementation, maxResponseBytes, timeoutMs, requestDigest } = state;
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: state.pluginRoot, manifestFile: state.manifestFile });
  requireValue(canonicalJson(binaryIdentity(selection)) === canonicalJson(state.binding.binaryIdentity)
    && selection.binaryPath === state.selection.binaryPath && selection.manifestPath === state.selection.manifestPath, "WORKER_FILE_EFFECT_PREPARED_BINARY_DRIFT");
  const cwd = path.dirname(selection.binaryPath);
  const command = process.platform === "win32" ? path.toNamespacedPath(selection.binaryPath) : selection.binaryPath;
  const args = ["--file-effect"];
  const processRecord = { parentPid: process.pid, command: selection.binaryPath, args, cwd, ports: [] };
  onProcess({ type: "planned", ...processRecord });
  return new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let transportError = null;
    let timeout;
    let forceTimer;
    let cleanupTimer;
    let stdoutLength = 0;
    let stderrLength = 0;
    let ownedSpawn = false;
    const chunks = [];
    const emit = (event) => { try { onProcess({ ...processRecord, pid: child?.pid, ...event }); } catch { return false; } return true; };
    const stop = (code) => {
      transportError ||= failure(code);
      if (finished || forceTimer) return;
      try { child?.kill("SIGTERM"); } catch { /* Still attempt exact-child force below. */ }
      forceTimer = setTimeout(() => {
        try { child?.kill("SIGKILL"); } catch { /* Report unverified cleanup if close never arrives. */ }
        cleanupTimer = setTimeout(() => {
          if (finished) return;
          finished = true; clearTimeout(timeout);
          emit({ type: "cleanup-unverified" });
          const error = failure("WORKER_FILE_EFFECT_CLEANUP_UNVERIFIED");
          error.pid = child?.pid; error.cause = transportError; reject(error);
        }, 2000);
      }, 500);
    };
    try { child = spawnImplementation(command, args, { cwd, env: environment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(failure("WORKER_FILE_EFFECT_SPAWN_FAILED")); return; }
    child.once("spawn", () => {
      if (finished || transportError) return;
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) { stop("WORKER_FILE_EFFECT_OWNERSHIP_UNVERIFIED"); return; }
      ownedSpawn = true;
      if (!emit({ type: "spawn" })) { stop("WORKER_FILE_EFFECT_PROCESS_OBSERVER_FAILED"); return; }
      try { child.stdin.end(input); } catch { stop("WORKER_FILE_EFFECT_INPUT_FAILED"); }
    });
    child.stdin.on("error", () => stop("WORKER_FILE_EFFECT_INPUT_FAILED"));
    child.stdout.on("error", () => stop("WORKER_FILE_EFFECT_OUTPUT_FAILED"));
    child.stderr.on("error", () => stop("WORKER_FILE_EFFECT_OUTPUT_FAILED"));
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxResponseBytes) { stop("WORKER_FILE_EFFECT_RESPONSE_LIMIT"); return; }
      if (!transportError) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      stop(stderrLength > Math.min(maxResponseBytes, 64 * 1024) ? "WORKER_FILE_EFFECT_STDERR_LIMIT" : "WORKER_FILE_EFFECT_UNEXPECTED_STDERR");
    });
    child.once("error", () => stop("WORKER_FILE_EFFECT_PROCESS_FAILED"));
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout); clearTimeout(forceTimer); clearTimeout(cleanupTimer);
      if (finished) return;
      finished = true;
      if (!emit({ type: "exit", exitCode, signal, cleanupVerified: true })) transportError ||= failure("WORKER_FILE_EFFECT_PROCESS_OBSERVER_FAILED");
      if (transportError) { reject(transportError); return; }
      try {
        requireValue(ownedSpawn, "WORKER_FILE_EFFECT_OWNERSHIP_UNVERIFIED");
        const bytes = Buffer.concat(chunks);
        const response = verifyResponse(bytes, request, requestDigest, exitCode, signal);
        const currentSelection = resolveVerifiedProcessSupervisor({ pluginRoot: state.pluginRoot, manifestFile: state.manifestFile });
        requireValue(canonicalJson(binaryIdentity(currentSelection)) === canonicalJson(state.binding.binaryIdentity)
          && currentSelection.binaryPath === state.selection.binaryPath && currentSelection.manifestPath === state.selection.manifestPath, "WORKER_FILE_EFFECT_PREPARED_BINARY_DRIFT");
        resolve({ response, terminalProof: terminalProof(state, bytes, response, exitCode) });
      }
      catch (error) { reject(error); }
    });
    timeout = setTimeout(() => stop("WORKER_FILE_EFFECT_TIMEOUT"), timeoutMs);
  });
}
