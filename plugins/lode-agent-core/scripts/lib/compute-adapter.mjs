import crypto from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";

export const COMPUTE_ADAPTER_CONTRACT_VERSION = "0.3.0";
export const WORKER_PROTOCOL_VERSION = "0.2.0";

export const DEFAULT_COMPUTE_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxFiles: 20_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});

const HARD_LIMITS = Object.freeze({
  timeoutMs: { min: 10, max: 300_000 },
  maxInputBytes: { min: 2, max: 64 * 1024 * 1024 },
  maxOutputBytes: { min: 2_048, max: 512 * 1024 * 1024 },
  maxFiles: { min: 1, max: 100_000 },
  maxFileBytes: { min: 1, max: 16 * 1024 * 1024 },
  maxTotalBytes: { min: 1, max: 1024 * 1024 * 1024 },
});

const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{2,127}\.v[1-9][0-9]*$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;
const AUTHORITY_FLAGS = new Set([
  "instructionAuthority",
  "promotionAuthority",
  "controlAuthority",
  "canonicalAuthority",
  "uniqueAuthority",
]);

const fail = (message, code = "COMPUTE_ADAPTER_ERROR", details = null) => {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
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

function byteLength(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function consumeAdapterDiagnostics(adapter, requestId) {
  if (typeof adapter.consumeExecutionDiagnostics !== "function") return {};
  const value = adapter.consumeExecutionDiagnostics(requestId);
  if (value == null) return {};
  assertJsonValue(value, "Compute adapter diagnostics");
  assertFields(value, [
    "backend", "adapterName", "executionMode", "fallbackUsed", "fallbackReasonCode",
    "workerPid", "workerRelativePath", "workerSha256",
  ], "Compute adapter diagnostics");
  if (![value.backend, value.adapterName, value.executionMode, value.fallbackReasonCode, value.workerRelativePath, value.workerSha256]
    .every((item) => typeof item === "string") || typeof value.fallbackUsed !== "boolean"
    || (value.workerPid !== null && (!Number.isInteger(value.workerPid) || value.workerPid < 1))) {
    fail("Compute adapter diagnostics are invalid.", "INVALID_COMPUTE_ADAPTER_DIAGNOSTICS");
  }
  return canonical(value);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_WORKER_PROTOCOL");
  return value.trim();
}

function assertFields(record, allowed, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} must be an object.`, "INVALID_WORKER_PROTOCOL");
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_WORKER_PROTOCOL");
}

function assertJsonValue(value, label = "value", depth = 0) {
  if (depth > 100) fail(`${label} exceeds the maximum JSON nesting depth.`, "INVALID_COMPUTE_JSON");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number.`, "INVALID_COMPUTE_JSON");
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${label}[${index}]`, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must contain only plain JSON values.`, "INVALID_COMPUTE_JSON");
  }
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail(`${label} contains an unsafe key.`, "INVALID_COMPUTE_JSON");
    assertJsonValue(child, `${label}.${key}`, depth + 1);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeInteger(value, fallback, label) {
  const selected = value == null ? fallback : Number(value);
  const bounds = HARD_LIMITS[label];
  if (!Number.isInteger(selected) || selected < bounds.min || selected > bounds.max) {
    fail(`${label} must be an integer from ${bounds.min} to ${bounds.max}.`, "INVALID_COMPUTE_LIMIT");
  }
  return selected;
}

export function normalizeComputeLimits(limits = {}) {
  assertFields(limits, Object.keys(DEFAULT_COMPUTE_LIMITS), "Compute limits");
  return {
    timeoutMs: normalizeInteger(limits.timeoutMs, DEFAULT_COMPUTE_LIMITS.timeoutMs, "timeoutMs"),
    maxInputBytes: normalizeInteger(limits.maxInputBytes, DEFAULT_COMPUTE_LIMITS.maxInputBytes, "maxInputBytes"),
    maxOutputBytes: normalizeInteger(limits.maxOutputBytes, DEFAULT_COMPUTE_LIMITS.maxOutputBytes, "maxOutputBytes"),
    maxFiles: normalizeInteger(limits.maxFiles, DEFAULT_COMPUTE_LIMITS.maxFiles, "maxFiles"),
    maxFileBytes: normalizeInteger(limits.maxFileBytes, DEFAULT_COMPUTE_LIMITS.maxFileBytes, "maxFileBytes"),
    maxTotalBytes: normalizeInteger(limits.maxTotalBytes, DEFAULT_COMPUTE_LIMITS.maxTotalBytes, "maxTotalBytes"),
  };
}

function normalizeSemanticProducer(value) {
  assertFields(value, ["name", "version"], "Semantic producer");
  const name = requiredText(value.name, "Semantic producer name");
  const version = requiredText(value.version, "Semantic producer version");
  if (name.length > 128 || version.length > 64) fail("Semantic producer metadata is too long.", "INVALID_WORKER_PROTOCOL");
  return { name, version };
}

function normalizeMessages(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`, "INVALID_WORKER_PROTOCOL");
  if (values.length > 100) fail(`${label} exceeds the maximum record count.`, "INVALID_WORKER_PROTOCOL");
  return values.map((value, index) => {
    assertFields(value, ["code", "message", "details"], `${label}[${index}]`);
    const code = requiredText(value.code, `${label}[${index}].code`);
    if (!CODE_PATTERN.test(code)) fail(`${label}[${index}].code is invalid.`, "INVALID_WORKER_PROTOCOL");
    const message = requiredText(value.message, `${label}[${index}].message`);
    if (message.length > 4_096) fail(`${label}[${index}].message is too long.`, "INVALID_WORKER_PROTOCOL");
    const normalized = { code, message };
    if (value.details != null) {
      assertJsonValue(value.details, `${label}[${index}].details`);
      assertNoAuthorityEscalation(value.details, `${label}[${index}].details`);
      if (byteLength(value.details) > 64 * 1024) fail(`${label}[${index}].details is too large.`, "INVALID_WORKER_PROTOCOL");
      normalized.details = canonical(value.details);
    }
    return normalized;
  }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
}

function assertNoAuthorityEscalation(value, label = "Compute result") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoAuthorityEscalation(value[index], `${label}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY_FLAGS.has(key) && child !== false) {
      fail(`${label}.${key} must be false when emitted by a compute backend.`, "COMPUTE_AUTHORITY_ESCALATION");
    }
    assertNoAuthorityEscalation(child, `${label}.${key}`);
  }
}

function buildRequest({ operation, input, semanticProducer, limits = {} }, protocolName) {
  const normalizedOperation = requiredText(operation, "Compute operation");
  if (!OPERATION_PATTERN.test(normalizedOperation)) fail("Compute operation is invalid.", "INVALID_COMPUTE_OPERATION");
  assertJsonValue(input, "Compute input");
  const normalizedInput = canonical(input);
  const normalizedLimits = normalizeComputeLimits(limits);
  const normalizedProducer = normalizeSemanticProducer(semanticProducer);
  const inputBytes = byteLength(normalizedInput);
  if (inputBytes > normalizedLimits.maxInputBytes) fail("Compute input exceeds maxInputBytes.", "COMPUTE_INPUT_LIMIT");
  const inputDigest = digest(canonicalJson(normalizedInput));
  const identity = {
    schemaVersion: 1,
    protocol: { name: protocolName, version: WORKER_PROTOCOL_VERSION },
    kind: "ComputeRequest",
    operation: normalizedOperation,
    inputDigest,
    semanticProducer: normalizedProducer,
    limits: normalizedLimits,
  };
  const requestId = `compute-request-${digest(canonicalJson(identity)).slice(0, 24)}`;
  return deepFreeze({ ...identity, requestId, input: normalizedInput, authorityEffect: "none" });
}

export function buildComputeRequest({ storage = null, ...options } = {}) {
  return buildRequest(options, formatForVerifiedOwner(storage).dialect === "lode"
    ? "lode-agent-core-worker-protocol" : "head-agent-core-worker-protocol");
}

export function validateComputeRequest(request) {
  assertFields(request, ["schemaVersion", "protocol", "kind", "requestId", "operation", "inputDigest", "semanticProducer", "limits", "input", "authorityEffect"], "Compute request");
  if (!["head-agent-core-worker-protocol", "lode-agent-core-worker-protocol"].includes(request.protocol?.name)) {
    fail("Compute request identity or protocol verification failed.", "COMPUTE_REQUEST_MISMATCH");
  }
  const lode = request.protocol.name === "lode-agent-core-worker-protocol";
  const producers = {
    "worker.health.v1": lode ? "lode-agent-core-worker-health" : "head-agent-core-worker-health",
    "worker.lifecycle.v1": lode ? "lode-agent-core-worker-lifecycle" : "head-agent-core-worker-lifecycle",
  };
  const rebuilt = buildRequest({
    operation: request.operation,
    input: request.input,
    semanticProducer: request.semanticProducer,
    limits: request.limits,
  }, request.protocol.name);
  if (canonicalJson(request) !== canonicalJson(rebuilt)) {
    fail("Compute request identity or protocol verification failed.", "COMPUTE_REQUEST_MISMATCH");
  }
  const scopeFormat = request.operation === "repository.scan.v1"
    ? familyFormatForOriginal("head-agent-core-repository-source-scope", request.input?.sourceScope) : null;
  if (producers[request.operation] && request.semanticProducer?.name !== producers[request.operation]
    || request.operation === "worker.health.v1" && request.input?.probe !== (lode ? "lode-agent-core" : "head-agent-core")
    || request.operation === "repository.scan.v1" && (!scopeFormat || (scopeFormat.dialect === "lode") !== lode
      || request.semanticProducer?.name !== scopeFormat.protocol("head-agent-core-repository-scan"))) {
    fail("Compute request family is incoherent.", "COMPUTE_REQUEST_MISMATCH");
  }
  return request;
}

function responseEnvelope(request) {
  return {
    schemaVersion: 1,
    protocol: request.protocol,
    kind: "ComputeResponse",
    requestId: request.requestId,
    operation: request.operation,
    inputDigest: request.inputDigest,
    semanticProducer: request.semanticProducer,
    authorityEffect: "none",
  };
}

function prepareComputeResult(result, warnings) {
  assertJsonValue(result, "Compute result");
  assertNoAuthorityEscalation(result);
  const normalizedResult = deepFreeze(canonical(result));
  let resultJson;
  try {
    resultJson = JSON.stringify(normalizedResult);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fail("Compute result exceeds the JSON runtime's string capacity; output-budget retries cannot fix this runtime limit.", "COMPUTE_OUTPUT_RUNTIME_LIMIT");
  }
  const resultBytes = Buffer.byteLength(resultJson, "utf8");
  return { result: normalizedResult, resultBytes, resultCodeUnits: resultJson.length,
    resultDigest: resultBytes <= HARD_LIMITS.maxOutputBytes.max ? digest(resultJson) : "",
    warnings: normalizeMessages(warnings, "Compute warnings") };
}

function verifyPreparedOutputSize(request, response, prepared) {
  const envelopeJson = JSON.stringify({ ...response, result: null });
  if (Buffer.byteLength(envelopeJson, "utf8") - 4 + prepared.resultBytes > request.limits.maxOutputBytes) fail("Compute response exceeds maxOutputBytes.", "COMPUTE_OUTPUT_LIMIT");
  if (envelopeJson.length - 4 + prepared.resultCodeUnits > bufferConstants.MAX_STRING_LENGTH) {
    fail("Compute response exceeds the JSON runtime's string capacity; output-budget retries cannot fix this runtime limit.", "COMPUTE_OUTPUT_RUNTIME_LIMIT");
  }
}

function successFromPrepared(request, prepared) {
  validateComputeRequest(request);
  if (prepared.resultBytes > request.limits.maxOutputBytes) fail("Compute result exceeds maxOutputBytes.", "COMPUTE_OUTPUT_LIMIT");
  const response = {
    ...responseEnvelope(request),
    status: "ok",
    result: prepared.result,
    resultDigest: prepared.resultDigest,
    warnings: prepared.warnings,
    errors: [],
  };
  // Exact UTF-8 envelope accounting, without another giant JSON string/copy.
  verifyPreparedOutputSize(request, response, prepared);
  return deepFreeze(response);
}

export function buildComputeSuccessResponse(request, result, { warnings = [] } = {}) {
  validateComputeRequest(request);
  return successFromPrepared(request, prepareComputeResult(result, warnings));
}

function nextOutputRequest(request) {
  return buildRequest({ operation: request.operation, input: request.input, semanticProducer: request.semanticProducer,
    limits: { ...request.limits, maxOutputBytes: request.limits.maxOutputBytes * 2 } }, request.protocol.name);
}

function outputRetryDiagnostics(attempts, explicit) {
  return { outputBudgetAttempts: [...attempts], outputRetryCount: Math.max(0, attempts.length - 1),
    outputBudgetAutomatic: !explicit, outputBudgetCeiling: explicit ? attempts[0] ?? null : HARD_LIMITS.maxOutputBytes.max };
}

function outputFailureMessage(attempts, explicit) {
  const finalMiB = attempts.at(-1) / (1024 * 1024);
  return explicit
    ? `Compute output exceeds the explicit ${attempts[0]}-byte budget; automatic growth is disabled (0 retries).`
    : `Compute output exceeds ${finalMiB} MiB after ${attempts.length - 1} retries; the 512 MiB output ceiling was reached.`;
}

function annotateOutputAttemptError(error, attempts, explicit) {
  if (!error || typeof error !== "object") return error;
  error.details = { ...error.details, ...outputRetryDiagnostics(attempts, explicit) };
  if (error.code === "COMPUTE_OUTPUT_RUNTIME_LIMIT" && !error.message.includes("Last output budget")) {
    error.message += ` Last output budget ${attempts.at(-1)} bytes after ${Math.max(0, attempts.length - 1)} retries (ceiling ${HARD_LIMITS.maxOutputBytes.max} bytes).`;
  }
  return error;
}

// Internal repository-scan plumbing, not a new Host/MCP surface. Retain one
// completed private result; never repeat the source scan or any project writer.
export function completeComputeResult(request, result, { limits = {} } = {}) {
  validateComputeRequest(request);
  const explicit = Object.hasOwn(limits, "maxOutputBytes") || request.limits.maxOutputBytes !== DEFAULT_COMPUTE_LIMITS.maxOutputBytes;
  let prepared;
  try { prepared = prepareComputeResult(result, []); }
  catch (error) {
    throw annotateOutputAttemptError(error, [request.limits.maxOutputBytes], explicit);
  }
  const attempts = [];
  for (;;) {
    attempts.push(request.limits.maxOutputBytes);
    try {
      return { request, response: successFromPrepared(request, prepared), diagnostics: outputRetryDiagnostics(attempts, explicit) };
    } catch (error) {
      if (error.code !== "COMPUTE_OUTPUT_LIMIT") {
        throw annotateOutputAttemptError(error, attempts, explicit);
      }
      if (explicit || attempts.length >= 4 || request.limits.maxOutputBytes >= HARD_LIMITS.maxOutputBytes.max) {
        error.message = outputFailureMessage(attempts, explicit);
        error.details = { ...error.details, ...outputRetryDiagnostics(attempts, explicit), cause: "COMPUTE_OUTPUT_LIMIT" };
        throw error;
      }
      request = nextOutputRequest(request);
    }
  }
}

export function buildComputeErrorResponse(request, errors, { warnings = [] } = {}) {
  validateComputeRequest(request);
  const normalizedErrors = normalizeMessages(errors, "Compute errors");
  if (normalizedErrors.length === 0) fail("A failed compute response requires at least one error.", "INVALID_WORKER_PROTOCOL");
  const response = {
    ...responseEnvelope(request),
    status: "error",
    result: null,
    resultDigest: "",
    warnings: normalizeMessages(warnings, "Compute warnings"),
    errors: normalizedErrors,
  };
  if (byteLength(response) > request.limits.maxOutputBytes) fail("Compute response exceeds maxOutputBytes.", "COMPUTE_OUTPUT_LIMIT");
  return deepFreeze(response);
}

export function validateComputeResponse(request, response) {
  validateComputeRequest(request);
  assertFields(response, ["schemaVersion", "protocol", "kind", "requestId", "operation", "inputDigest", "semanticProducer", "authorityEffect", "status", "result", "resultDigest", "warnings", "errors"], "Compute response");
  if (response.schemaVersion !== 1 || response.kind !== "ComputeResponse" || response.authorityEffect !== "none"
    || response.requestId !== request.requestId || response.operation !== request.operation
    || response.inputDigest !== request.inputDigest || canonicalJson(response.protocol) !== canonicalJson(request.protocol)
    || canonicalJson(response.semanticProducer) !== canonicalJson(request.semanticProducer)) {
    fail("Compute response does not match its request.", "COMPUTE_RESPONSE_MISMATCH");
  }
  const warnings = normalizeMessages(response.warnings, "Compute warnings");
  const errors = normalizeMessages(response.errors, "Compute errors");
  if (canonicalJson(warnings) !== canonicalJson(response.warnings) || canonicalJson(errors) !== canonicalJson(response.errors)) {
    fail("Compute response messages are not canonically ordered.", "COMPUTE_RESPONSE_MISMATCH");
  }
  if (response.status === "ok") {
    if (errors.length !== 0) fail("A successful compute response cannot contain errors.", "COMPUTE_RESPONSE_MISMATCH");
    const prepared = prepareComputeResult(response.result, warnings);
    if (response.resultDigest !== prepared.resultDigest) {
      fail("Compute result digest or output limit verification failed.", "COMPUTE_RESULT_MISMATCH");
    }
    verifyPreparedOutputSize(request, response, prepared);
  } else if (response.status === "error") {
    if (response.result !== null || response.resultDigest !== "" || errors.length === 0) {
      fail("A failed compute response has an invalid result or error set.", "COMPUTE_RESPONSE_MISMATCH");
    }
    if (byteLength(response) > request.limits.maxOutputBytes) fail("Compute response exceeds maxOutputBytes.", "COMPUTE_OUTPUT_LIMIT");
  } else {
    fail("Compute response status is invalid.", "COMPUTE_RESPONSE_MISMATCH");
  }
  return response;
}

function normalizeOperationHandlers(operations) {
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) fail("JavaScript compute operations must be an object.", "INVALID_COMPUTE_ADAPTER");
  const normalized = new Map();
  for (const operation of Object.keys(operations).sort()) {
    if (!OPERATION_PATTERN.test(operation) || typeof operations[operation] !== "function") {
      fail(`JavaScript compute operation is invalid: ${operation}`, "INVALID_COMPUTE_ADAPTER");
    }
    normalized.set(operation, operations[operation]);
  }
  return normalized;
}

export class JsReferenceComputeAdapter {
  #operations;
  #completedResults = new WeakMap();

  constructor({ operations, name = "javascript-reference" } = {}) {
    this.#operations = normalizeOperationHandlers(operations || {});
    this.name = requiredText(name, "Compute adapter name");
  }

  describe() {
    return {
      contractVersion: COMPUTE_ADAPTER_CONTRACT_VERSION,
      backend: "javascript-reference",
      name: this.name,
      executionMode: "in-process",
      supportedOperations: [...this.#operations.keys()],
      semanticIdentity: "backend-neutral-canonical-output",
      authority: "computation-only",
      instructionAuthority: false,
      promotionAuthority: false,
      controlAuthority: false,
      mutatesProject: false,
      mutatesCanon: false,
      fallback: "self",
    };
  }

  async execute(request, { signal = null, outputRetryToken = null } = {}) {
    validateComputeRequest(request);
    if (signal?.aborted) return buildComputeErrorResponse(request, [{ code: "COMPUTE_CANCELLED", message: "Compute request was cancelled." }]);
    const handler = this.#operations.get(request.operation);
    if (!handler) return buildComputeErrorResponse(request, [{ code: "UNSUPPORTED_COMPUTE_OPERATION", message: `Unsupported compute operation: ${request.operation}` }]);
    try {
      const binding = canonicalJson({ operation: request.operation, protocol: request.protocol, inputDigest: request.inputDigest,
        semanticProducer: request.semanticProducer, limits: { ...request.limits, maxOutputBytes: 0 } });
      let completed = outputRetryToken ? this.#completedResults.get(outputRetryToken) : null;
      if (completed && completed.binding !== binding) fail("Retained compute result does not match this operation.", "COMPUTE_REQUEST_MISMATCH");
      if (!completed) {
        const result = await handler(deepFreeze(canonical(request.input)), {
          requestId: request.requestId, semanticProducer: request.semanticProducer, limits: request.limits, signal,
        });
        completed = { binding, prepared: prepareComputeResult(result, []) };
        if (outputRetryToken) this.#completedResults.set(outputRetryToken, completed);
      }
      if (signal?.aborted) return buildComputeErrorResponse(request, [{ code: "COMPUTE_CANCELLED", message: "Compute request was cancelled." }]);
      return successFromPrepared(request, completed.prepared);
    } catch (error) {
      const code = typeof error?.code === "string" && CODE_PATTERN.test(error.code) ? error.code : "JS_REFERENCE_OPERATION_FAILED";
      return buildComputeErrorResponse(request, [{ code, message: error?.message || "JavaScript reference operation failed." }]);
    }
  }
}

export function validateComputeAdapter(adapter, { storage = null } = {}) {
  if (!adapter || typeof adapter.describe !== "function" || typeof adapter.execute !== "function") fail("Compute adapter must implement describe and execute.", "INVALID_COMPUTE_ADAPTER");
  const descriptor = adapter.describe({ storage });
  assertFields(descriptor, ["contractVersion", "backend", "name", "executionMode", "supportedOperations", "semanticIdentity", "authority", "instructionAuthority", "promotionAuthority", "controlAuthority", "mutatesProject", "mutatesCanon", "fallback"], "Compute adapter descriptor");
  if (descriptor.contractVersion !== COMPUTE_ADAPTER_CONTRACT_VERSION
    || descriptor.semanticIdentity !== "backend-neutral-canonical-output"
    || descriptor.authority !== "computation-only"
    || descriptor.instructionAuthority !== false || descriptor.promotionAuthority !== false
    || descriptor.controlAuthority !== false || descriptor.mutatesProject !== false || descriptor.mutatesCanon !== false) {
    fail("Compute adapter violates the authority or semantic identity contract.", "INVALID_COMPUTE_ADAPTER");
  }
  for (const field of ["backend", "name", "executionMode", "fallback"]) {
    if (requiredText(descriptor[field], `Compute adapter ${field}`).length > 128) fail(`Compute adapter ${field} is too long.`, "INVALID_COMPUTE_ADAPTER");
  }
  if (!Array.isArray(descriptor.supportedOperations)
    || canonicalJson([...descriptor.supportedOperations].sort()) !== canonicalJson(descriptor.supportedOperations)
    || new Set(descriptor.supportedOperations).size !== descriptor.supportedOperations.length
    || descriptor.supportedOperations.some((operation) => !OPERATION_PATTERN.test(operation))) {
    fail("Compute adapter operations are invalid or nondeterministic.", "INVALID_COMPUTE_ADAPTER");
  }
  return descriptor;
}

export async function executeComputeOperation({ adapter, operation, input, semanticProducer, limits = {}, signal = null, storage = null } = {}) {
  const descriptor = validateComputeAdapter(adapter, { storage });
  let request = buildComputeRequest({ operation, input, semanticProducer, limits, storage });
  const explicitOutput = Object.hasOwn(limits, "maxOutputBytes");
  if (!descriptor.supportedOperations.includes(request.operation)) fail(`Compute adapter does not support ${request.operation}.`, "UNSUPPORTED_COMPUTE_OPERATION");
  if (signal?.aborted) fail("Compute operation was cancelled.", "COMPUTE_CANCELLED");
  const controller = new AbortController();
  let cancellation = null;
  let timer = null;
  const started = performance.now();
  const attempts = [];
  const outputRetryToken = {}; // Invocation-local; WeakMap retention ends here.
  let cancellationPromise = null;
  if (signal) {
    cancellationPromise = new Promise((_, reject) => {
      cancellation = () => {
        const error = new Error("Compute operation was cancelled.");
        error.code = "COMPUTE_CANCELLED";
        reject(error);
        controller.abort(error);
      };
      signal.addEventListener("abort", cancellation, { once: true });
    });
  }
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Compute operation timed out.");
        error.code = "COMPUTE_TIMEOUT";
        reject(error);
        controller.abort(error);
      }, request.limits.timeoutMs);
    });
    const ensureActive = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (signal?.aborted) fail("Compute operation was cancelled.", "COMPUTE_CANCELLED");
      if (performance.now() - started >= request.limits.timeoutMs) {
        const error = Object.assign(new Error("Compute operation timed out."), { code: "COMPUTE_TIMEOUT" });
        controller.abort(error);
        throw error;
      }
    };
    for (;;) {
      ensureActive();
      attempts.push(request.limits.maxOutputBytes);
      const racers = [Promise.resolve(adapter.execute(request, { signal: controller.signal, outputRetryToken })), timeout];
      if (cancellationPromise) racers.push(cancellationPromise);
      const response = await Promise.race(racers);
      ensureActive();
      // Validate identity, messages, digest and authority before classifying an
      // error. An invalid/oversized success is not a trusted retry instruction.
      validateComputeResponse(request, response);
      const adapterDiagnostics = consumeAdapterDiagnostics(adapter, request.requestId);
      if (response.status !== "ok") {
        const outputOnly = response.errors.length === 1 && response.errors[0].code === "COMPUTE_OUTPUT_LIMIT";
        if (outputOnly && !explicitOutput && attempts.length < 4 && request.limits.maxOutputBytes < HARD_LIMITS.maxOutputBytes.max) {
          request = nextOutputRequest(request);
          continue;
        }
        const runtimeOnly = response.errors.length === 1 && response.errors[0].code === "COMPUTE_OUTPUT_RUNTIME_LIMIT";
        fail(outputOnly ? outputFailureMessage(attempts, explicitOutput) : runtimeOnly
          ? `${response.errors[0].message} Last output budget ${attempts.at(-1)} bytes after ${attempts.length - 1} retries (ceiling ${HARD_LIMITS.maxOutputBytes.max} bytes).`
          : "Compute operation failed.", "COMPUTE_OPERATION_FAILED", {
          requestId: request.requestId, errors: response.errors, warnings: response.warnings,
          diagnostics: { ...adapterDiagnostics, ...outputRetryDiagnostics(attempts, explicitOutput) },
        });
      }
      return {
        request, response, result: response.result,
        diagnostics: {
          backend: adapterDiagnostics.backend || descriptor.backend, adapterName: adapterDiagnostics.adapterName || descriptor.name,
          executionMode: adapterDiagnostics.executionMode || descriptor.executionMode, ...adapterDiagnostics,
          ...outputRetryDiagnostics(attempts, explicitOutput), elapsedMs: Math.max(0, performance.now() - started),
        },
      };
    }
  } catch (error) {
    throw annotateOutputAttemptError(error, attempts, explicitOutput);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && cancellation) signal.removeEventListener("abort", cancellation);
  }
}

export async function verifyComputeAdapterConformance({ referenceAdapter, candidateAdapter, fixtures } = {}) {
  const reference = validateComputeAdapter(referenceAdapter);
  const candidate = validateComputeAdapter(candidateAdapter);
  if (!Array.isArray(fixtures) || fixtures.length === 0) fail("Compute conformance requires fixtures.", "COMPUTE_FIXTURES_REQUIRED");
  const records = [];
  const names = new Set();
  for (const fixture of fixtures) {
    assertFields(fixture, ["name", "operation", "input", "semanticProducer", "limits"], "Compute fixture");
    const name = requiredText(fixture.name, "Compute fixture name");
    if (names.has(name)) fail(`Duplicate compute fixture: ${name}`, "DUPLICATE_COMPUTE_FIXTURE");
    names.add(name);
    const request = buildComputeRequest(fixture);
    if (!reference.supportedOperations.includes(request.operation) || !candidate.supportedOperations.includes(request.operation)) {
      fail(`Compute fixture operation is not supported by both adapters: ${request.operation}`, "UNSUPPORTED_COMPUTE_OPERATION");
    }
    const referenceResponse = await referenceAdapter.execute(request);
    const candidateResponse = await candidateAdapter.execute(request);
    validateComputeResponse(request, referenceResponse);
    validateComputeResponse(request, candidateResponse);
    if (typeof referenceAdapter.consumeExecutionDiagnostics === "function") referenceAdapter.consumeExecutionDiagnostics(request.requestId);
    if (typeof candidateAdapter.consumeExecutionDiagnostics === "function") candidateAdapter.consumeExecutionDiagnostics(request.requestId);
    if (canonicalJson(referenceResponse) !== canonicalJson(candidateResponse)) {
      fail(`Compute adapters disagree for fixture: ${name}`, "COMPUTE_CONFORMANCE_MISMATCH", {
        requestId: request.requestId,
        referenceResultDigest: referenceResponse.resultDigest,
        candidateResultDigest: candidateResponse.resultDigest,
      });
    }
    records.push({ name, operation: request.operation, requestId: request.requestId, status: referenceResponse.status, resultDigest: referenceResponse.resultDigest });
  }
  records.sort((left, right) => compareText(left.name, right.name));
  const payload = {
    schemaVersion: 1,
    kind: "ComputeConformanceReport",
    contractVersion: COMPUTE_ADAPTER_CONTRACT_VERSION,
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    referenceBackend: reference.backend,
    candidateBackend: candidate.backend,
    fixtures: records,
    authorityEffect: "none",
  };
  const conformanceReportHash = digest(canonicalJson(payload));
  return { ...payload, conformanceReportId: `compute-conformance-${conformanceReportHash.slice(0, 24)}`, conformanceReportHash };
}
