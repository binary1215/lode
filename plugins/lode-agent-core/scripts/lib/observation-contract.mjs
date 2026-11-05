import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import { SCHEMA_VERSION } from "./lode-core.mjs";

export const OBSERVATION_PROTOCOL_VERSION = "0.1.0";
export const OBSERVATION_FORMS = Object.freeze(["event", "snapshot", "aggregate"]);
export const OBSERVATION_COVERAGE_STATES = Object.freeze(["complete", "sampled", "partial", "unknown"]);

const FIELD_TYPES = new Set([
  "string", "stable-key", "timestamp", "sha256", "boolean", "integer",
  "nonnegative-integer", "bounded-number", "enum", "array",
]);
const ARRAY_ITEM_TYPES = new Set(["string", "stable-key", "timestamp", "sha256", "boolean", "integer", "nonnegative-integer", "bounded-number"]);
const DEFAULT_STRING_MAX_BYTES = 8192;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const fail = (message, code = "OBSERVATION_CONTRACT_ERROR") => { const error = new Error(message); error.code = code; throw error; };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function observationCanonicalJson(value) { return JSON.stringify(canonical(value)); }
export function observationDigest(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : observationCanonicalJson(value)).digest("hex"); }

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_OBSERVATION_INPUT");
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (observationCanonicalJson(actual) !== observationCanonicalJson(expected)) fail(`${label} fields are invalid.`, "INVALID_OBSERVATION_INPUT");
}

export function stableKey(value, label = "value", max = 128) {
  const normalized = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) fail(`${label} must be a stable namespaced key.`, "INVALID_OBSERVATION_INPUT");
  return normalized;
}

function requiredText(value, label, max = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > max) fail(`${label} is invalid.`, "INVALID_OBSERVATION_INPUT");
  return normalized;
}

function digestValue(value, label) {
  const normalized = String(value || "").toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(`${label} must be a SHA-256 digest.`, "INVALID_OBSERVATION_INPUT");
  return normalized;
}

function timestamp(value, label) {
  const normalized = requiredText(value, label, 64);
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date-time.`, "INVALID_OBSERVATION_INPUT");
  return new Date(normalized).toISOString();
}

function identity(payload, prefix, idField, hashField) {
  const hash = observationDigest(payload);
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function verifyIdentity(document, prefix, idField, hashField, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail(`${label} is invalid.`, "INVALID_OBSERVATION_ARTIFACT");
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = observationDigest(payload);
  if (document[hashField] !== hash || document[idField] !== `${prefix}-${hash.slice(0, 24)}`) fail(`${label} digest verification failed.`, "OBSERVATION_DIGEST_MISMATCH");
  return document;
}

function normalizeField(field, index) {
  const allowed = new Set(["key", "type", "required", "min", "max", "enum", "itemsType", "maxItems"]);
  if (!field || typeof field !== "object" || Array.isArray(field) || Object.keys(field).some((key) => !allowed.has(key))) fail(`Observation schema field ${index} is invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
  const key = stableKey(field.key, `Observation schema field ${index} key`, 96);
  const type = String(field.type || "").trim();
  if (!FIELD_TYPES.has(type)) fail(`Observation schema field ${key} has an unsupported type.`, "INVALID_OBSERVATION_DESCRIPTOR");
  const normalized = { key, type, required: field.required === true };
  if (field.min != null) {
    if (!Number.isFinite(Number(field.min))) fail(`Observation schema field ${key} min is invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
    normalized.min = Number(field.min);
  }
  if (field.max != null) {
    if (!Number.isFinite(Number(field.max))) fail(`Observation schema field ${key} max is invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
    normalized.max = Number(field.max);
  }
  if (normalized.min != null && normalized.max != null && normalized.min > normalized.max) fail(`Observation schema field ${key} bounds are invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
  if (type === "string" && normalized.max == null) normalized.max = DEFAULT_STRING_MAX_BYTES;
  if (type === "string" && (!Number.isInteger(normalized.max) || normalized.max < 1 || normalized.max > 65_536
    || normalized.min != null && (!Number.isInteger(normalized.min) || normalized.min < 0))) fail(`Observation schema field ${key} string bounds are invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
  if (type === "enum") {
    if (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || field.enum.some((item) => !["string", "number", "boolean"].includes(typeof item))) fail(`Observation schema field ${key} enum is invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
    normalized.enum = [...new Set(field.enum.map((item) => observationCanonicalJson(item)))].map((item) => JSON.parse(item)).sort((a, b) => observationCanonicalJson(a).localeCompare(observationCanonicalJson(b)));
  }
  if (type === "array") {
    const itemsType = String(field.itemsType || "").trim();
    const maxItems = Number(field.maxItems);
    if (!ARRAY_ITEM_TYPES.has(itemsType) || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > 1024) fail(`Observation schema field ${key} array contract is invalid.`, "INVALID_OBSERVATION_DESCRIPTOR");
    normalized.itemsType = itemsType;
    normalized.maxItems = maxItems;
  }
  return normalized;
}

export function createObservationTypeDescriptor(input = {}, storage = null) {
  const format = formatForVerifiedOwner(storage);
  exactFields(input, ["typeKey", "typeVersion", "forms", "payloadSchema"], "ObservationTypeDescriptor input");
  const forms = Array.isArray(input.forms) ? [...new Set(input.forms.map((item) => String(item).trim()))].sort() : [];
  if (!forms.length || forms.some((item) => !OBSERVATION_FORMS.includes(item))) fail("ObservationTypeDescriptor forms are invalid.", "INVALID_OBSERVATION_DESCRIPTOR");
  exactFields(input.payloadSchema, ["fields", "additionalFields"], "Observation payload schema");
  if (input.payloadSchema.additionalFields !== false || !Array.isArray(input.payloadSchema.fields) || input.payloadSchema.fields.length > 128) fail("Observation payload schema must be closed and bounded.", "INVALID_OBSERVATION_DESCRIPTOR");
  const fields = input.payloadSchema.fields.map(normalizeField).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(fields.map((field) => field.key)).size !== fields.length) fail("Observation payload schema has duplicate fields.", "INVALID_OBSERVATION_DESCRIPTOR");
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationTypeDescriptor",
    protocol: { name: format.protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
    typeKey: stableKey(input.typeKey, "Observation typeKey", 192),
    typeVersion: stableKey(input.typeVersion, "Observation typeVersion", 64),
    forms,
    payloadSchema: { fields, additionalFields: false },
    authority: "data-shape-contract-not-product-meaning",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  return verifyObservationTypeDescriptor(identity(payload, "observation-type", "descriptorId", "descriptorHash"));
}

export function verifyObservationTypeDescriptor(document, storage = undefined) {
  const format = familyFormatForOriginal("head-agent-core-observation", document, storage);
  exactFields(document, ["schemaVersion", "kind", "protocol", "typeKey", "typeVersion", "forms", "payloadSchema", "authority", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "descriptorId", "descriptorHash"], "ObservationTypeDescriptor");
  exactFields(document.protocol, ["name", "version"], "ObservationTypeDescriptor protocol");
  exactFields(document.payloadSchema, ["fields", "additionalFields"], "ObservationTypeDescriptor payloadSchema");
  verifyIdentity(document, "observation-type", "descriptorId", "descriptorHash", "ObservationTypeDescriptor");
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ObservationTypeDescriptor"
    || !format || document.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || !document.typeKey || !document.typeVersion || !Array.isArray(document.forms) || !document.forms.length
    || document.forms.some((item) => !OBSERVATION_FORMS.includes(item)) || document.payloadSchema?.additionalFields !== false
    || !Array.isArray(document.payloadSchema?.fields)
    || document.authority !== "data-shape-contract-not-product-meaning" || document.instructionAuthority !== false
    || document.promotionAuthority !== false || document.recoveryAuthority !== false) fail("ObservationTypeDescriptor fields or authority are invalid.", "INVALID_OBSERVATION_DESCRIPTOR");
  stableKey(document.typeKey, "Observation typeKey", 192);
  stableKey(document.typeVersion, "Observation typeVersion", 64);
  const normalizedFields = document.payloadSchema.fields.map(normalizeField).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(normalizedFields.map((field) => field.key)).size !== normalizedFields.length
    || observationCanonicalJson(normalizedFields) !== observationCanonicalJson(document.payloadSchema.fields)
    || observationCanonicalJson([...new Set(document.forms)].sort()) !== observationCanonicalJson(document.forms)) fail("ObservationTypeDescriptor normalization mismatch.", "INVALID_OBSERVATION_DESCRIPTOR");
  return document;
}

function validateScalar(value, field, label) {
  if (field.type === "string" && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > (field.max ?? DEFAULT_STRING_MAX_BYTES)
    || field.min != null && Buffer.byteLength(value, "utf8") < field.min)) fail(`${label} must be a bounded string.`, "INVALID_OBSERVATION_PAYLOAD");
  if (field.type === "stable-key") stableKey(value, label, 256);
  if (field.type === "timestamp") timestamp(value, label);
  if (field.type === "sha256") digestValue(value, label);
  if (field.type === "boolean" && typeof value !== "boolean") fail(`${label} must be boolean.`, "INVALID_OBSERVATION_PAYLOAD");
  if (field.type === "integer" && !Number.isInteger(value)) fail(`${label} must be an integer.`, "INVALID_OBSERVATION_PAYLOAD");
  if (field.type === "nonnegative-integer" && (!Number.isInteger(value) || value < 0)) fail(`${label} must be a nonnegative integer.`, "INVALID_OBSERVATION_PAYLOAD");
  if (field.type === "bounded-number" && !Number.isFinite(value)) fail(`${label} must be a finite number.`, "INVALID_OBSERVATION_PAYLOAD");
  if (field.type === "enum" && !field.enum.some((item) => observationCanonicalJson(item) === observationCanonicalJson(value))) fail(`${label} is outside its enum.`, "INVALID_OBSERVATION_PAYLOAD");
  if (["integer", "nonnegative-integer", "bounded-number"].includes(field.type)) {
    if (field.min != null && value < field.min) fail(`${label} is below its minimum.`, "INVALID_OBSERVATION_PAYLOAD");
    if (field.max != null && value > field.max) fail(`${label} is above its maximum.`, "INVALID_OBSERVATION_PAYLOAD");
  }
  return value;
}

export function validateObservationPayload(descriptor, payload) {
  verifyObservationTypeDescriptor(descriptor);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Observation payload must be an object.", "INVALID_OBSERVATION_PAYLOAD");
  const fields = new Map(descriptor.payloadSchema.fields.map((field) => [field.key, field]));
  const unknown = Object.keys(payload).filter((key) => !fields.has(key));
  if (unknown.length) fail(`Observation payload has unsupported fields: ${unknown.sort().join(", ")}.`, "INVALID_OBSERVATION_PAYLOAD");
  for (const field of fields.values()) {
    if (!(field.key in payload)) {
      if (field.required) fail(`Observation payload is missing ${field.key}.`, "INVALID_OBSERVATION_PAYLOAD");
      continue;
    }
    const value = payload[field.key];
    if (field.type === "array") {
      if (!Array.isArray(value) || value.length > field.maxItems) fail(`Observation payload ${field.key} exceeds its array contract.`, "INVALID_OBSERVATION_PAYLOAD");
      const itemField = { ...field, type: field.itemsType };
      value.forEach((item, index) => validateScalar(item, itemField, `Observation payload ${field.key}[${index}]`));
    } else validateScalar(value, field, `Observation payload ${field.key}`);
  }
  if (Buffer.byteLength(observationCanonicalJson(payload), "utf8") > MAX_PAYLOAD_BYTES) fail("Observation payload exceeds its total size bound.", "INVALID_OBSERVATION_PAYLOAD");
  return canonical(payload);
}

function normalizeTemporalScope(value, form) {
  exactFields(value, ["observedAt", "start", "end"], "Observation temporalScope");
  const observedAt = timestamp(value.observedAt, "Observation observedAt");
  const start = value.start == null ? null : timestamp(value.start, "Observation start");
  const end = value.end == null ? null : timestamp(value.end, "Observation end");
  if ((start === null) !== (end === null) || start && Date.parse(start) > Date.parse(end)) fail("Observation temporal window is invalid.", "INVALID_OBSERVATION_INPUT");
  if (form === "aggregate" && start === null) fail("Aggregate Observation requires a bounded time window.", "INVALID_OBSERVATION_INPUT");
  return { observedAt, start, end };
}

function normalizeCoverage(value) {
  exactFields(value, ["state", "basis", "queryDigest", "examinedCount", "sourceReportedTotal", "omittedCount", "cursorStartDigest", "cursorEndDigest"], "Observation coverage");
  const state = String(value.state || "").trim();
  if (!OBSERVATION_COVERAGE_STATES.includes(state)) fail("Observation coverage state is invalid.", "INVALID_OBSERVATION_COVERAGE");
  const nullableDigest = (item, label) => item == null ? null : digestValue(item, label);
  const coverage = {
    state,
    basis: stableKey(value.basis, "Observation coverage basis", 128),
    queryDigest: nullableDigest(value.queryDigest, "Observation queryDigest"),
    examinedCount: Number(value.examinedCount),
    sourceReportedTotal: value.sourceReportedTotal == null ? null : Number(value.sourceReportedTotal),
    omittedCount: value.omittedCount == null ? null : Number(value.omittedCount),
    cursorStartDigest: nullableDigest(value.cursorStartDigest, "Observation cursorStartDigest"),
    cursorEndDigest: nullableDigest(value.cursorEndDigest, "Observation cursorEndDigest"),
  };
  if (!Number.isInteger(coverage.examinedCount) || coverage.examinedCount < 0
    || coverage.sourceReportedTotal != null && (!Number.isInteger(coverage.sourceReportedTotal) || coverage.sourceReportedTotal < 0)
    || coverage.omittedCount != null && (!Number.isInteger(coverage.omittedCount) || coverage.omittedCount < 0)) fail("Observation coverage counts are invalid.", "INVALID_OBSERVATION_COVERAGE");
  if (state === "complete" && (coverage.basis !== "enumerated-bounded-query" || !coverage.queryDigest
    || coverage.sourceReportedTotal !== coverage.examinedCount || coverage.omittedCount !== 0)) fail("Complete coverage requires bounded enumeration proof.", "UNPROVEN_COMPLETE_OBSERVATION_COVERAGE");
  return coverage;
}

function nonAuthorityValid(document, authority) {
  return document.authority === authority && document.instructionAuthority === false && document.promotionAuthority === false
    && document.mutatesCanon === false && document.recoveryAuthority === false;
}

export function createObservationRecord({ projectId, descriptor, subject, form, temporalScope, source, coverage, payload } = {}, storage = null) {
  const format = formatForVerifiedOwner(storage);
  const verifiedDescriptor = verifyObservationTypeDescriptor(descriptor, storage);
  if (!verifiedDescriptor.forms.includes(form)) fail("Observation form is not allowed by its descriptor.", "INVALID_OBSERVATION_INPUT");
  exactFields(subject, ["type", "key"], "Observation subject");
  exactFields(source, ["adapterKey", "adapterVersion", "sourceScopeDigest", "sourceEventKeyDigest", "sourceEvidenceDigest"], "Observation source");
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationRecord",
    protocol: { name: format.protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId: requiredText(projectId, "Observation projectId", 256),
    descriptorId: verifiedDescriptor.descriptorId,
    descriptorHash: verifiedDescriptor.descriptorHash,
    typeKey: verifiedDescriptor.typeKey,
    typeVersion: verifiedDescriptor.typeVersion,
    subject: { type: stableKey(subject.type, "Observation subject type", 192), key: stableKey(subject.key, "Observation subject key", 192) },
    form,
    temporalScope: normalizeTemporalScope(temporalScope, form),
    source: {
      adapterKey: stableKey(source.adapterKey, "Observation adapterKey", 192),
      adapterVersion: stableKey(source.adapterVersion, "Observation adapterVersion", 64),
      sourceScopeDigest: digestValue(source.sourceScopeDigest, "Observation sourceScopeDigest"),
      sourceEventKeyDigest: digestValue(source.sourceEventKeyDigest, "Observation sourceEventKeyDigest"),
      sourceEvidenceDigest: digestValue(source.sourceEvidenceDigest, "Observation sourceEvidenceDigest"),
    },
    coverage: normalizeCoverage(coverage),
    payload: validateObservationPayload(verifiedDescriptor, payload),
    epistemicClass: "observed-fact",
    authority: "non-authoritative-observation-evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
  };
  return verifyObservationRecord(identity(body, "observation", "observationId", "observationHash"), verifiedDescriptor, projectId);
}

export function verifyObservationRecord(document, descriptor, projectId = "", storage) {
  const format = familyFormatForOriginal("head-agent-core-observation", document, storage);
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "descriptorId", "descriptorHash", "typeKey", "typeVersion", "subject", "form", "temporalScope", "source", "coverage", "payload", "epistemicClass", "authority", "instructionAuthority", "promotionAuthority", "mutatesCanon", "recoveryAuthority", "observationId", "observationHash"], "ObservationRecord");
  exactFields(document.protocol, ["name", "version"], "ObservationRecord protocol");
  exactFields(document.subject, ["type", "key"], "ObservationRecord subject");
  exactFields(document.source, ["adapterKey", "adapterVersion", "sourceScopeDigest", "sourceEventKeyDigest", "sourceEvidenceDigest"], "ObservationRecord source");
  verifyIdentity(document, "observation", "observationId", "observationHash", "ObservationRecord");
  const verifiedDescriptor = verifyObservationTypeDescriptor(descriptor, storage);
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ObservationRecord"
    || !format || document.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || document.protocol?.name !== verifiedDescriptor.protocol.name
    || projectId && document.projectId !== projectId || document.descriptorId !== verifiedDescriptor.descriptorId
    || document.descriptorHash !== verifiedDescriptor.descriptorHash || document.typeKey !== verifiedDescriptor.typeKey
    || document.typeVersion !== verifiedDescriptor.typeVersion || !verifiedDescriptor.forms.includes(document.form)
    || document.epistemicClass !== "observed-fact" || !nonAuthorityValid(document, "non-authoritative-observation-evidence")) fail("ObservationRecord fields or authority are invalid.", "INVALID_OBSERVATION_RECORD");
  normalizeTemporalScope(document.temporalScope, document.form);
  normalizeCoverage(document.coverage);
  validateObservationPayload(verifiedDescriptor, document.payload);
  requiredText(document.projectId, "Observation projectId", 256);
  stableKey(document.subject.type, "Observation subject type", 192);
  stableKey(document.subject.key, "Observation subject key", 192);
  stableKey(document.source.adapterKey, "Observation adapterKey", 192);
  stableKey(document.source.adapterVersion, "Observation adapterVersion", 64);
  digestValue(document.source.sourceScopeDigest, "Observation sourceScopeDigest");
  digestValue(document.source.sourceEventKeyDigest, "Observation sourceEventKeyDigest");
  digestValue(document.source.sourceEvidenceDigest, "Observation sourceEvidenceDigest");
  return document;
}

export function createDerivedObservationRecord({ projectId, descriptor, subject, temporalScope, inputObservations, algorithm, coverage, payload } = {}, storage = null) {
  const format = formatForVerifiedOwner(storage);
  const verifiedDescriptor = verifyObservationTypeDescriptor(descriptor, storage);
  if (!Array.isArray(inputObservations) || !inputObservations.length || inputObservations.length > 64) fail("DerivedObservationRecord requires bounded input observations.", "INVALID_DERIVED_OBSERVATION");
  const inputs = inputObservations.map((item) => {
    if (!item || !/^observation-[a-f0-9]{24}$/.test(item.observationId || "") || !/^[a-f0-9]{64}$/.test(item.observationHash || "")) fail("DerivedObservationRecord input identity is invalid.", "INVALID_DERIVED_OBSERVATION");
    return { observationId: item.observationId, observationHash: item.observationHash };
  }).sort((a, b) => a.observationId.localeCompare(b.observationId));
  if (new Set(inputs.map((item) => item.observationId)).size !== inputs.length) fail("DerivedObservationRecord inputs are duplicated.", "INVALID_DERIVED_OBSERVATION");
  exactFields(subject, ["type", "key"], "Derived Observation subject");
  exactFields(algorithm, ["key", "version", "digest"], "Derived Observation algorithm");
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "DerivedObservationRecord",
    protocol: { name: format.protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId: requiredText(projectId, "Derived Observation projectId", 256),
    descriptorId: verifiedDescriptor.descriptorId,
    descriptorHash: verifiedDescriptor.descriptorHash,
    typeKey: verifiedDescriptor.typeKey,
    typeVersion: verifiedDescriptor.typeVersion,
    subject: { type: stableKey(subject.type, "Derived Observation subject type", 192), key: stableKey(subject.key, "Derived Observation subject key", 192) },
    form: "comparison",
    temporalScope: normalizeTemporalScope(temporalScope, "aggregate"),
    inputObservations: inputs,
    algorithm: { key: stableKey(algorithm.key, "Derived Observation algorithm key", 192), version: stableKey(algorithm.version, "Derived Observation algorithm version", 64), digest: digestValue(algorithm.digest, "Derived Observation algorithm digest") },
    coverage: normalizeCoverage(coverage),
    payload: validateObservationPayload(verifiedDescriptor, payload),
    epistemicClass: "derived-projection",
    authority: "non-authoritative-derived-observation-evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
    recoveryAuthority: false,
  };
  return verifyDerivedObservationRecord(identity(body, "derived-observation", "derivedObservationId", "derivedObservationHash"), verifiedDescriptor, projectId);
}

export function verifyDerivedObservationRecord(document, descriptor, projectId = "", storage) {
  const format = familyFormatForOriginal("head-agent-core-observation", document, storage);
  exactFields(document, ["schemaVersion", "kind", "protocol", "projectId", "descriptorId", "descriptorHash", "typeKey", "typeVersion", "subject", "form", "temporalScope", "inputObservations", "algorithm", "coverage", "payload", "epistemicClass", "authority", "instructionAuthority", "promotionAuthority", "mutatesCanon", "recoveryAuthority", "derivedObservationId", "derivedObservationHash"], "DerivedObservationRecord");
  exactFields(document.protocol, ["name", "version"], "DerivedObservationRecord protocol");
  exactFields(document.subject, ["type", "key"], "DerivedObservationRecord subject");
  exactFields(document.algorithm, ["key", "version", "digest"], "DerivedObservationRecord algorithm");
  verifyIdentity(document, "derived-observation", "derivedObservationId", "derivedObservationHash", "DerivedObservationRecord");
  const verifiedDescriptor = verifyObservationTypeDescriptor(descriptor, storage);
  if (document.schemaVersion !== SCHEMA_VERSION || document.kind !== "DerivedObservationRecord"
    || !format || document.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || document.protocol?.name !== verifiedDescriptor.protocol.name
    || projectId && document.projectId !== projectId || document.descriptorId !== verifiedDescriptor.descriptorId
    || document.descriptorHash !== verifiedDescriptor.descriptorHash || document.typeKey !== verifiedDescriptor.typeKey
    || document.typeVersion !== verifiedDescriptor.typeVersion || document.form !== "comparison"
    || !Array.isArray(document.inputObservations) || !document.inputObservations.length
    || document.epistemicClass !== "derived-projection" || !nonAuthorityValid(document, "non-authoritative-derived-observation-evidence")) fail("DerivedObservationRecord fields or authority are invalid.", "INVALID_DERIVED_OBSERVATION");
  normalizeTemporalScope(document.temporalScope, "aggregate");
  normalizeCoverage(document.coverage);
  validateObservationPayload(verifiedDescriptor, document.payload);
  requiredText(document.projectId, "Derived Observation projectId", 256);
  stableKey(document.subject.type, "Derived Observation subject type", 192);
  stableKey(document.subject.key, "Derived Observation subject key", 192);
  stableKey(document.algorithm.key, "Derived Observation algorithm key", 192);
  stableKey(document.algorithm.version, "Derived Observation algorithm version", 64);
  digestValue(document.algorithm.digest, "Derived Observation algorithm digest");
  const normalizedInputs = document.inputObservations.map((item) => {
    exactFields(item, ["observationId", "observationHash"], "DerivedObservationRecord input");
    if (!/^observation-[a-f0-9]{24}$/.test(item.observationId || "") || !/^[a-f0-9]{64}$/.test(item.observationHash || "")) fail("DerivedObservationRecord input identity is invalid.", "INVALID_DERIVED_OBSERVATION");
    return { observationId: item.observationId, observationHash: item.observationHash };
  }).sort((a, b) => a.observationId.localeCompare(b.observationId));
  if (normalizedInputs.length > 64 || new Set(normalizedInputs.map((item) => item.observationId)).size !== normalizedInputs.length
    || observationCanonicalJson(normalizedInputs) !== observationCanonicalJson(document.inputObservations)) fail("DerivedObservationRecord input normalization is invalid.", "INVALID_DERIVED_OBSERVATION");
  return document;
}
