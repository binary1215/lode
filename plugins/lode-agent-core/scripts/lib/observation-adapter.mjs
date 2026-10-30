import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  OBSERVATION_PROTOCOL_VERSION,
  createObservationTypeDescriptor,
  observationDigest,
  stableKey,
  verifyObservationTypeDescriptor,
} from "./observation-contract.mjs";
import { assertObservationProjectReady, recordCollectedObservation } from "./observation-store.mjs";

const fail = (message, code = "OBSERVATION_ADAPTER_ERROR") => { const error = new Error(message); error.code = code; throw error; };
const JSON_EVENT_FILE_ADAPTER_KEY = "head.json-event-file-observation";
const MAX_EVENT_FILE_BYTES = 512 * 1024;
const MAX_INSPECTED_SOURCES = 64;
const MAX_SOURCE_SHAPE_FIELDS = 16;
const SOURCE_AVAILABILITY_STATES = new Set(["unknown", "ready", "auth-missing", "rate-limited", "unavailable"]);

function exactFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_OBSERVATION_SOURCE_EVENT");
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_OBSERVATION_SOURCE_EVENT");
}

function requiredText(value, label, maxBytes = 8192) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) fail(`${label} is invalid.`, "INVALID_OBSERVATION_SOURCE_EVENT");
  return value.trim();
}

function optionalStableKey(value, label, maxBytes = 192) {
  const normalized = String(value || "").trim();
  return normalized ? stableKey(normalized, label, maxBytes) : "";
}

function optionalTimestamp(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date-time.`, "INVALID_OBSERVATION_SOURCE_AVAILABILITY");
  return new Date(normalized).toISOString();
}

function normalizeSourceAvailability(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Observation source availability must be an object.", "INVALID_OBSERVATION_SOURCE_AVAILABILITY");
  const unexpected = Object.keys(value).filter((key) => !["state", "observedAt", "retryAfter", "reasonCode"].includes(key));
  if (unexpected.length) fail(`Observation source availability contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_OBSERVATION_SOURCE_AVAILABILITY");
  const state = String(value.state || "unknown").trim();
  if (!SOURCE_AVAILABILITY_STATES.has(state)) fail("Observation source availability state is invalid.", "INVALID_OBSERVATION_SOURCE_AVAILABILITY");
  const observedAt = optionalTimestamp(value.observedAt, "Observation source availability observedAt");
  const retryAfter = optionalTimestamp(value.retryAfter, "Observation source availability retryAfter");
  const reasonCode = optionalStableKey(value.reasonCode, "Observation source availability reasonCode", 96) || null;
  if (state === "ready" && (retryAfter || reasonCode)) fail("A ready Observation source cannot carry an unavailable reason or retry time.", "INVALID_OBSERVATION_SOURCE_AVAILABILITY");
  return { state, observedAt, retryAfter, reasonCode, evidence: "host-local-operational-hint", semanticAuthority: false };
}

function sourceShape(descriptor) {
  const fields = descriptor.payloadSchema.fields.slice(0, MAX_SOURCE_SHAPE_FIELDS).map((field) => ({ key: field.key, type: field.type, required: field.required }));
  return {
    typeKey: descriptor.typeKey,
    typeVersion: descriptor.typeVersion,
    forms: [...descriptor.forms],
    fields,
    omittedFieldCount: Math.max(0, descriptor.payloadSchema.fields.length - fields.length),
    productMeaningAssigned: false,
    semanticAuthority: false,
  };
}

function readBoundedRegularFile(file, maxBytes) {
  let initial;
  try { initial = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") fail("JSON Observation event file does not exist.", "OBSERVATION_EVENT_FILE_MISSING");
    fail(`JSON Observation event file cannot be inspected: ${error.message}`, "UNSAFE_OBSERVATION_EVENT_FILE");
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maxBytes) fail("JSON Observation event file is unsafe or exceeds its byte bound.", "UNSAFE_OBSERVATION_EVENT_FILE");
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes
      || initial.dev !== opened.dev || initial.ino !== opened.ino) fail("JSON Observation event file changed identity or exceeds its byte bound.", "UNSAFE_OBSERVATION_EVENT_FILE");
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const count = fs.readSync(descriptor, bytes, offset, maxBytes + 1 - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > maxBytes) fail("JSON Observation event file exceeds its byte bound.", "UNSAFE_OBSERVATION_EVENT_FILE");
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (["OBSERVATION_EVENT_FILE_MISSING", "UNSAFE_OBSERVATION_EVENT_FILE"].includes(error?.code)) throw error;
    fail(`JSON Observation event file cannot be read safely: ${error.message}`, "UNSAFE_OBSERVATION_EVENT_FILE");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function digestValue(value, label) {
  const normalized = String(value || "").toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(`${label} must be a SHA-256 digest.`, "INVALID_OBSERVATION_SOURCE_BINDING");
  return normalized;
}
export function normalizeObservationSourceBinding(binding = {}) {
  const allowed = new Set(["adapterKey", "adapterVersion", "sourceScopeDigest", "credentialReferenceNames"]);
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).some((key) => !allowed.has(key))) fail("ObservationSourceBinding fields are invalid.", "INVALID_OBSERVATION_SOURCE_BINDING");
  const credentialReferenceNames = Array.isArray(binding.credentialReferenceNames) ? [...new Set(binding.credentialReferenceNames.map((item) => String(item).trim()))].sort() : [];
  if (credentialReferenceNames.length > 16 || credentialReferenceNames.some((item) => !/^[A-Z][A-Z0-9_]{2,127}$/u.test(item))) fail("ObservationSourceBinding credential references are invalid.", "INVALID_OBSERVATION_SOURCE_BINDING");
  return {
    adapterKey: stableKey(binding.adapterKey, "ObservationSourceBinding adapterKey", 192),
    adapterVersion: stableKey(binding.adapterVersion, "ObservationSourceBinding adapterVersion", 64),
    sourceScopeDigest: digestValue(binding.sourceScopeDigest, "ObservationSourceBinding sourceScopeDigest"),
    credentialReferenceNames,
  };
}

export class StructuredObservationAdapter {
  constructor({ descriptor, input } = {}, storage = null) {
    this.format = formatForVerifiedOwner(storage);
    this.adapterVersion = OBSERVATION_PROTOCOL_VERSION;
    this.descriptor = descriptor?.kind === "ObservationTypeDescriptor" ? verifyObservationTypeDescriptor(descriptor, storage) : createObservationTypeDescriptor(descriptor, storage);
    this.input = input;
  }

  describe() {
    return {
      adapterKey: this.format.value("head.structured-host-observation"),
      adapterVersion: this.adapterVersion,
      descriptorId: this.descriptor.descriptorId,
      descriptorHash: this.descriptor.descriptorHash,
      authority: "observed-evidence-only",
      providerNeutral: true,
      persistsCredentials: false,
      persistsProviderIdentity: false,
      executesProjectCode: false,
    };
  }

  collect() { return this.input; }
}

export class JsonEventFileObservationAdapter {
  constructor({ descriptor, eventFile, maxBytes = MAX_EVENT_FILE_BYTES } = {}, storage = null) {
    this.format = formatForVerifiedOwner(storage);
    this.adapterVersion = OBSERVATION_PROTOCOL_VERSION;
    this.descriptor = descriptor?.kind === "ObservationTypeDescriptor" ? verifyObservationTypeDescriptor(descriptor, storage) : createObservationTypeDescriptor(descriptor, storage);
    if (typeof eventFile !== "string" || !path.isAbsolute(eventFile)) fail("JSON Observation event file must be an absolute Host path.", "INVALID_OBSERVATION_EVENT_FILE");
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EVENT_FILE_BYTES) fail("JSON Observation event file byte bound is invalid.", "INVALID_OBSERVATION_EVENT_FILE_BOUND");
    this.eventFile = path.resolve(eventFile);
    this.maxBytes = maxBytes;
  }

  describe() {
    return {
      adapterKey: this.format.value(JSON_EVENT_FILE_ADAPTER_KEY),
      adapterVersion: this.adapterVersion,
      descriptorId: this.descriptor.descriptorId,
      descriptorHash: this.descriptor.descriptorHash,
      authority: "observed-evidence-only",
      providerNeutral: true,
      persistsCredentials: false,
      persistsProviderIdentity: false,
      executesProjectCode: false,
    };
  }

  collect({ sourceScopeDigest } = {}) {
    const source = readBoundedRegularFile(this.eventFile, this.maxBytes);
    let event;
    try { event = JSON.parse(source); }
    catch (error) { fail(`JSON Observation event file is invalid: ${error.message}`, "INVALID_OBSERVATION_SOURCE_EVENT"); }
    exactFields(event, ["schemaVersion", "eventKey", "subject", "form", "temporalScope", "coverage", "payload"], "JSON Observation source event");
    if (event.schemaVersion !== 1) fail("JSON Observation source event schemaVersion must be 1.", "INVALID_OBSERVATION_SOURCE_EVENT");
    const eventKey = requiredText(event.eventKey, "JSON Observation source event key");
    const normalized = {
      subject: event.subject,
      form: event.form,
      temporalScope: event.temporalScope,
      coverage: event.coverage,
      payload: event.payload,
    };
    return {
      ...normalized,
      sourceEventKeyDigest: observationDigest({ sourceScopeDigest, eventKey }),
      sourceEvidenceDigest: observationDigest({ schemaVersion: event.schemaVersion, eventKey, ...normalized }),
    };
  }
}

export function assertObservationAdapter(adapter, binding, descriptor, storage = undefined) {
  if (!adapter || typeof adapter !== "object" || typeof adapter.describe !== "function" || typeof adapter.collect !== "function") fail("ObservationAdapter is invalid.", "INVALID_OBSERVATION_ADAPTER");
  const selectedBinding = normalizeObservationSourceBinding(binding);
  const selectedDescriptor = descriptor?.kind === "ObservationTypeDescriptor" ? verifyObservationTypeDescriptor(descriptor, storage) : createObservationTypeDescriptor(descriptor, storage);
  const described = adapter.describe();
  if (described.adapterKey !== selectedBinding.adapterKey || described.adapterVersion !== selectedBinding.adapterVersion
    || described.descriptorId !== selectedDescriptor.descriptorId || described.descriptorHash !== selectedDescriptor.descriptorHash
    || described.authority !== "observed-evidence-only" || described.providerNeutral !== true
    || described.persistsCredentials !== false || described.persistsProviderIdentity !== false || described.executesProjectCode !== false) fail("ObservationAdapter crosses its source, descriptor, or authority boundary.", "INVALID_OBSERVATION_ADAPTER_AUTHORITY");
  return { adapter, binding: selectedBinding, descriptor: selectedDescriptor, descriptorDigest: observationDigest(described), described };
}

export class ObservationAdapterRegistry {
  #sources = new Map();
  #sourceKeysById = new Map();

  register({ projectRoot, sourceKey, binding, descriptor, adapter, availability = {} } = {}) {
    const inspected = assertObservationProjectReady(projectRoot);
    const normalizedSourceKey = stableKey(sourceKey, "Observation adapter source key", 192);
    const storageKey = `${inspected.project.projectId}:${normalizedSourceKey}`;
    if (this.#sources.has(storageKey)) fail("Observation adapter source key is already registered for this HEAD Project.", "DUPLICATE_OBSERVATION_ADAPTER_SOURCE");
    const asserted = assertObservationAdapter(adapter, binding, descriptor, inspected.storage);
    const sourceId = `observation-source-${observationDigest({
      projectId: inspected.project.projectId,
      sourceKey: normalizedSourceKey,
      adapterKey: asserted.binding.adapterKey,
      adapterVersion: asserted.binding.adapterVersion,
      sourceScopeDigest: asserted.binding.sourceScopeDigest,
      descriptorId: asserted.descriptor.descriptorId,
    }).slice(0, 24)}`;
    const entry = {
      sourceId,
      sourceKey: normalizedSourceKey,
      projectId: inspected.project.projectId,
      projectRoot: inspected.project.projectRoot,
      availability: normalizeSourceAvailability(availability),
      ...asserted,
    };
    this.#sources.set(storageKey, entry);
    this.#sourceKeysById.set(sourceId, storageKey);
    return this.#project(entry);
  }

  #project(entry) {
    return {
      sourceId: entry.sourceId,
      projectId: entry.projectId,
      adapterKey: entry.binding.adapterKey,
      adapterVersion: entry.binding.adapterVersion,
      descriptorId: entry.descriptor.descriptorId,
      typeKey: entry.descriptor.typeKey,
      shape: sourceShape(entry.descriptor),
      availability: entry.availability,
      sourceScopeDigest: entry.binding.sourceScopeDigest,
      credentialReferenceCount: entry.binding.credentialReferenceNames.length,
      stateLocation: "host-local-outside-project",
      sourceConfigurationPersistedInProject: false,
      sourceCursorPersistedInProject: false,
      providerIdentityPersisted: false,
      productMeaningAssigned: false,
    };
  }

  inspect({ root, typeKey = "", adapterKey = "", availabilityState = "", limit = MAX_INSPECTED_SOURCES, projectionId = "", cursor = "" } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INSPECTED_SOURCES) fail("Observation adapter registry inspection limit is invalid.", "INVALID_OBSERVATION_ADAPTER_INSPECTION_LIMIT");
    const inspected = assertObservationProjectReady(root);
    const filters = {
      typeKey: optionalStableKey(typeKey, "Observation source typeKey"),
      adapterKey: optionalStableKey(adapterKey, "Observation source adapterKey"),
      availabilityState: String(availabilityState || "").trim(),
    };
    if (filters.availabilityState && !SOURCE_AVAILABILITY_STATES.has(filters.availabilityState)) fail("Observation source availability filter is invalid.", "INVALID_OBSERVATION_ADAPTER_INSPECTION_FILTER");
    const cursorId = String(cursor || "").trim();
    const expectedProjectionId = String(projectionId || "").trim();
    if (Boolean(cursorId) !== Boolean(expectedProjectionId)) fail("Observation source cursor and projectionId must be supplied together.", "INVALID_OBSERVATION_ADAPTER_INSPECTION_CURSOR");
    if (cursorId && !/^observation-source-[a-f0-9]{24}$/.test(cursorId)) fail("Observation source cursor is invalid.", "INVALID_OBSERVATION_ADAPTER_INSPECTION_CURSOR");
    if (expectedProjectionId && !/^observation-source-projection-[a-f0-9]{24}$/.test(expectedProjectionId)) fail("Observation source projectionId is invalid.", "INVALID_OBSERVATION_ADAPTER_INSPECTION_CURSOR");
    const projectSources = [...this.#sources.values()]
      .filter((entry) => entry.projectId === inspected.project.projectId && entry.projectRoot === inspected.project.projectRoot)
      .map((entry) => this.#project(entry))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const matchingSources = projectSources.filter((source) => (!filters.typeKey || source.typeKey === filters.typeKey)
      && (!filters.adapterKey || source.adapterKey === filters.adapterKey)
      && (!filters.availabilityState || source.availability.state === filters.availabilityState));
    const projectionHash = observationDigest({ projectId: inspected.project.projectId, filters, sources: matchingSources });
    const currentProjectionId = `observation-source-projection-${projectionHash.slice(0, 24)}`;
    let start = 0;
    let resynchronized = false;
    if (cursorId) {
      if (expectedProjectionId === currentProjectionId) {
        const index = matchingSources.findIndex((source) => source.sourceId === cursorId);
        if (index >= 0) start = index + 1;
        else resynchronized = true;
      } else resynchronized = true;
    }
    const sources = matchingSources.slice(start, start + limit);
    const remaining = Math.max(0, matchingSources.length - start - sources.length);
    return {
      schemaVersion: 1,
      kind: "ObservationSourceDiscoveryProjection",
      protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
      status: "available",
      projectId: inspected.project.projectId,
      projectionId: currentProjectionId,
      projectionHash,
      filters,
      configuredSourceCount: projectSources.length,
      matchingSourceCount: matchingSources.length,
      sources,
      nextCursor: remaining && sources.length ? { projectionId: currentProjectionId, sourceId: sources.at(-1).sourceId } : null,
      resynchronization: {
        occurred: resynchronized,
        reason: resynchronized ? "source-registry-or-filter-projection-changed" : null,
        restartedAtFirstPage: resynchronized,
      },
      bounded: {
        maxReturnedSources: MAX_INSPECTED_SOURCES,
        returnedSourceCount: sources.length,
        omittedSourceCount: matchingSources.length - sources.length,
        remainingSourceCount: remaining,
        shapeFieldLimit: MAX_SOURCE_SHAPE_FIELDS,
      },
      dynamicProjectCodeLoading: false,
      persisted: false,
      authority: "P5-host-configuration-only",
      projectionAuthority: "P4-non-persisted-source-discovery",
      semanticSelection: false,
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
    };
  }

  async collect({ root = ".", sourceKey = "", sourceId = "" } = {}) {
    const inspected = assertObservationProjectReady(root);
    if (Boolean(sourceKey) === Boolean(sourceId)) fail("Exactly one Observation adapter source selector is required.", "INVALID_OBSERVATION_ADAPTER_SOURCE_SELECTOR");
    let storageKey;
    if (sourceId) {
      if (!/^observation-source-[a-f0-9]{24}$/.test(sourceId)) fail("Observation adapter source ID is invalid.", "INVALID_OBSERVATION_ADAPTER_SOURCE_SELECTOR");
      storageKey = this.#sourceKeysById.get(sourceId) || "";
    } else storageKey = `${inspected.project.projectId}:${stableKey(sourceKey, "Observation adapter source key", 192)}`;
    const entry = this.#sources.get(storageKey);
    if (!entry) fail("Observation adapter source is not registered in this Host process.", "OBSERVATION_ADAPTER_SOURCE_NOT_FOUND");
    if (entry.projectId !== inspected.project.projectId || entry.projectRoot !== inspected.project.projectRoot) fail("Observation adapter source belongs to another HEAD Project.", "OBSERVATION_ADAPTER_SOURCE_PROJECT_MISMATCH");
    const result = await collectObservation({ root: inspected.project.projectRoot, binding: entry.binding, descriptor: entry.descriptor, adapter: entry.adapter });
    return {
      ...result,
      hostSource: this.#project(entry),
      sourceAccess: "performed-by-registered-host-adapter",
    };
  }
}

export async function collectObservation({ root = ".", binding, descriptor, adapter } = {}) {
  const inspected = assertObservationProjectReady(root);
  const asserted = assertObservationAdapter(adapter, binding, descriptor, inspected.storage);
  const input = await asserted.adapter.collect({ root: inspected.project.projectRoot, sourceScopeDigest: asserted.binding.sourceScopeDigest, credentialReferenceNames: [...asserted.binding.credentialReferenceNames] });
  const recorded = recordCollectedObservation({ root: inspected.project.projectRoot, descriptor: asserted.descriptor, input, adapterDescriptor: asserted.described, sourceScopeDigest: asserted.binding.sourceScopeDigest });
  return {
    status: recorded.status,
    descriptor: recorded.descriptor,
    observation: recorded.observation,
    receipt: recorded.receipt,
    adapter: asserted.described,
    sourceBinding: {
      adapterKey: asserted.binding.adapterKey,
      adapterVersion: asserted.binding.adapterVersion,
      sourceScopeDigest: asserted.binding.sourceScopeDigest,
      credentialReferenceCount: asserted.binding.credentialReferenceNames.length,
      credentialsPersisted: false,
    },
    authority: { observation: "P3-evidence-only", productCanonMutated: false, reviewDecisionCreated: false, recoveryDirectionMutated: false },
  };
}

export async function ingestStructuredObservation({ root = ".", binding, descriptor, input } = {}) {
  // Preserve pure descriptor validation before the existing Project boundary.
  // Only the subsequently verified owner selects the persisted wire family.
  new StructuredObservationAdapter({ descriptor, input });
  const inspected = assertObservationProjectReady(root);
  return (await collectObservation({ root, binding, descriptor, adapter: new StructuredObservationAdapter({ descriptor, input }, inspected.storage) }));
}

export async function ingestJsonObservationEventFile({ root = ".", sourceKey, binding, descriptor, eventFile, maxBytes } = {}) {
  // Keep the original constructor's descriptor/path/byte-bound error order.
  new JsonEventFileObservationAdapter({ descriptor, eventFile, maxBytes });
  const inspected = assertObservationProjectReady(root);
  const registry = new ObservationAdapterRegistry();
  const adapter = new JsonEventFileObservationAdapter({ descriptor, eventFile, maxBytes }, inspected.storage);
  const selectedBinding = normalizeObservationSourceBinding(binding);
  const selectedSourceKey = String(sourceKey || "").trim() || `one-shot-${observationDigest({
    adapterKey: selectedBinding.adapterKey,
    adapterVersion: selectedBinding.adapterVersion,
    sourceScopeDigest: selectedBinding.sourceScopeDigest,
    descriptorId: adapter.descriptor.descriptorId,
  }).slice(0, 24)}`;
  registry.register({
    projectRoot: root,
    sourceKey: selectedSourceKey,
    binding: selectedBinding,
    descriptor,
    adapter,
  });
  return registry.collect({ root, sourceKey: selectedSourceKey });
}

export async function collectRegisteredObservation({ root = ".", registry, sourceId } = {}) {
  if (!(registry instanceof ObservationAdapterRegistry)) fail("No trusted Host Observation adapter registry is configured in this process.", "OBSERVATION_ADAPTER_REGISTRY_UNAVAILABLE");
  return registry.collect({ root, sourceId });
}

export function inspectObservationSources({ root = "", registry = null, typeKey = "", adapterKey = "", availabilityState = "", limit = MAX_INSPECTED_SOURCES, projectionId = "", cursor = "" } = {}, storage = null) {
  if (registry != null && !(registry instanceof ObservationAdapterRegistry)) fail("Host Observation adapter registry is invalid.", "INVALID_OBSERVATION_ADAPTER_REGISTRY");
  const configured = registry == null ? null : registry.inspect({ root, typeKey, adapterKey, availabilityState, limit, projectionId, cursor });
  const format = configured ? familyFormatForOriginal("head-agent-core-observation", configured) : formatForVerifiedOwner(storage);
  return {
    status: "available",
    protocol: configured?.protocol ?? { name: formatForVerifiedOwner(storage).protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
    adapters: [
      {
        adapterKey: format.value("head.structured-host-observation"),
        adapterVersion: OBSERVATION_PROTOCOL_VERSION,
        mode: "host-supplied-bounded-input",
        requiresExactSourceBinding: true,
        remoteCollectionWithoutBinding: false,
        authority: "observed-evidence-only",
        providerNeutral: true,
      },
      {
        adapterKey: format.value(JSON_EVENT_FILE_ADAPTER_KEY),
        adapterVersion: OBSERVATION_PROTOCOL_VERSION,
        mode: "host-ci-json-event-file-once",
        requiresExactSourceBinding: true,
        remoteCollectionWithoutBinding: false,
        sourcePathPersisted: false,
        rawEventKeyPersisted: false,
        authority: "observed-evidence-only",
        providerNeutral: true,
      },
    ],
    registry: configured || {
      status: "not-configured-in-this-process",
      configuredSourceCount: 0,
      sources: [],
      dynamicProjectCodeLoading: false,
      persisted: false,
      authority: "P5-host-configuration-only",
    },
    workflow: {
      semanticSelectionOwner: format.value("provider-head"),
      existingEvidenceFirst: "query-exact-current-observations-before-collecting",
      collectOnlyWhenDurableEvidenceIsRequired: true,
      automaticProductInterpretation: false,
      userAuthoredProvenanceRequired: false,
    },
    dynamicProjectCodeLoading: false,
    missingOptionalAdaptersBlockCore: false,
  };
}
