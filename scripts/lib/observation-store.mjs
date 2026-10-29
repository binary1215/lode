import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { noteProjectGraphChange } from "./discovery-index.mjs";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import {
  OBSERVATION_PROTOCOL_VERSION,
  createDerivedObservationRecord,
  createObservationRecord,
  createObservationTypeDescriptor,
  observationCanonicalJson,
  observationDigest,
  verifyDerivedObservationRecord,
  verifyObservationRecord,
  verifyObservationTypeDescriptor,
} from "./observation-contract.mjs";

export const OBSERVATION_DESCRIPTOR_DIRECTORY = ".head/observations/descriptors";
export const OBSERVATION_RECORD_DIRECTORY = ".head/observations/records/by-source-key";
export const DERIVED_OBSERVATION_DIRECTORY = ".head/observations/derived";
export const OBSERVATION_RECEIPT_DIRECTORY = ".head/observations/receipts";

const LIMITS = Object.freeze({ maxArtifacts: 4096, maxArtifactBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
const fail = (message, code = "OBSERVATION_STORE_ERROR") => { const error = new Error(message); error.code = code; throw error; };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function safeDirectory(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, ...relative.split("/"));
  const fromRoot = path.relative(root, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) fail("Observation path escapes project root.", "OBSERVATION_PATH_ESCAPE");
  let current = root;
  for (const segment of fromRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Observation path traverses a symlink.", "OBSERVATION_SYMLINK_PATH");
  }
  return directory;
}

function atomicCreate(file, content) {
  try { atomicCreateArtifact(file, content); return true; }
  catch (error) { if (error?.code === "EEXIST") return false; throw error; }
}

function readCreateOnly(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMITS.maxArtifactBytes) fail(`${label} is unsafe or too large.`, "OBSERVATION_STORE_LIMIT");
  return readStoredObject(file, label);
}

function readStoredObject(file, label) {
  // I/O errors remain I/O errors. Only JSON syntax and the required record
  // container shape are classified here, before readers access record fields.
  const text = fs.readFileSync(file, "utf8");
  let document;
  try { document = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail(`${label} contains invalid JSON: ${error.message}`, "INVALID_OBSERVATION_ARTIFACT");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) fail(`${label} must contain a JSON object.`, "INVALID_OBSERVATION_ARTIFACT");
  return document;
}

function persistCreateOnly(projectRoot, relative, fileName, document, divergentCode = "OBSERVATION_IMMUTABLE_COLLISION") {
  const file = path.join(safeDirectory(projectRoot, relative), fileName);
  const content = json(document);
  if (Buffer.byteLength(content, "utf8") > LIMITS.maxArtifactBytes) fail("Observation artifact exceeds its byte bound.", "OBSERVATION_STORE_LIMIT");
  if (fs.existsSync(file)) {
    const existing = readCreateOnly(file, "Create-only Observation artifact");
    if (observationCanonicalJson(existing) !== observationCanonicalJson(document)) fail(`Create-only Observation key has divergent content: ${fileName}`, divergentCode);
    return { status: "existing", file };
  }
  if (!atomicCreate(file, content)) {
    const existing = readCreateOnly(file, "Create-only Observation artifact");
    if (observationCanonicalJson(existing) !== observationCanonicalJson(document)) fail(`Create-only Observation key has divergent content: ${fileName}`, divergentCode);
    return { status: "existing", file };
  }
  return { status: "recorded", file };
}

function readDirectory(projectRoot, relative, label) {
  const directory = safeDirectory(projectRoot, relative);
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > LIMITS.maxArtifacts) fail(`${label} count exceeds its bound.`, "OBSERVATION_STORE_LIMIT");
  let totalBytes = 0;
  return entries.map((entry) => {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMITS.maxArtifactBytes) fail(`${label} artifact is unsafe or too large.`, "OBSERVATION_STORE_LIMIT");
    totalBytes += stat.size;
    if (totalBytes > LIMITS.maxTotalBytes) fail(`${label} total bytes exceed its bound. Use bounded source aggregation.`, "OBSERVATION_STORE_LIMIT");
    return readStoredObject(file, label);
  });
}

export function assertObservationProjectReady(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for Observation use; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function receiptIdentity(payload) {
  const hash = observationDigest(payload);
  return { ...payload, receiptId: `observation-receipt-${hash.slice(0, 24)}`, receiptHash: hash };
}

export function verifyObservationCollectionReceipt(document, projectId = "", storage) {
  const format = familyFormatForOriginal("head-agent-core-observation", document, storage);
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("ObservationCollectionReceipt is invalid.", "INVALID_OBSERVATION_RECEIPT");
  const expectedFields = ["schemaVersion", "kind", "protocol", "projectId", "observationId", "observationHash", "descriptorId", "adapterKey", "adapterVersion", "adapterDescriptorDigest", "sourceScopeDigest", "authority", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "receiptId", "receiptHash"].sort();
  if (observationCanonicalJson(Object.keys(document).sort()) !== observationCanonicalJson(expectedFields)
    || observationCanonicalJson(Object.keys(document.protocol || {}).sort()) !== observationCanonicalJson(["name", "version"])) fail("ObservationCollectionReceipt fields are invalid.", "INVALID_OBSERVATION_RECEIPT");
  const payload = { ...document }; delete payload.receiptId; delete payload.receiptHash;
  const hash = observationDigest(payload);
  if (document.receiptId !== `observation-receipt-${hash.slice(0, 24)}` || document.receiptHash !== hash
    || document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ObservationCollectionReceipt"
    || !format || document.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || projectId && document.projectId !== projectId || !/^observation-[a-f0-9]{24}$/.test(document.observationId || "")
    || !/^observation-type-[a-f0-9]{24}$/.test(document.descriptorId || "") || !/^[a-f0-9]{64}$/.test(document.observationHash || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(document.adapterKey || "") || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(document.adapterVersion || "")
    || !/^[a-f0-9]{64}$/.test(document.adapterDescriptorDigest || "") || !/^[a-f0-9]{64}$/.test(document.sourceScopeDigest || "")
    || document.authority !== "collection-evidence-not-source-or-product-authority" || document.instructionAuthority !== false
    || document.promotionAuthority !== false || document.recoveryAuthority !== false) fail("ObservationCollectionReceipt fields or authority are invalid.", "INVALID_OBSERVATION_RECEIPT");
  return document;
}

function descriptorMap(descriptors, storage) {
  const map = new Map();
  for (const descriptor of descriptors) {
    verifyObservationTypeDescriptor(descriptor, storage);
    if (map.has(descriptor.descriptorId)) fail("Duplicate ObservationTypeDescriptor.", "DUPLICATE_OBSERVATION_DESCRIPTOR");
    map.set(descriptor.descriptorId, descriptor);
  }
  return map;
}

function sourceReplayKeyDigest(source) {
  return observationDigest({
    adapterKey: source.adapterKey,
    adapterVersion: source.adapterVersion,
    sourceScopeDigest: source.sourceScopeDigest,
    sourceEventKeyDigest: source.sourceEventKeyDigest,
  });
}

function persistObservationRecord(projectRoot, record, storage = null) {
  const recordDirectory = relativeProjectArtifact(storage, "observations", "records", "by-source-key");
  const legacyFile = path.join(safeDirectory(projectRoot, recordDirectory), `${record.source.sourceEventKeyDigest}.json`);
  if (fs.existsSync(legacyFile)) {
    const stat = fs.lstatSync(legacyFile);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMITS.maxArtifactBytes) fail("Legacy Observation record is unsafe or too large.", "OBSERVATION_STORE_LIMIT");
    let existing;
    try { existing = JSON.parse(fs.readFileSync(legacyFile, "utf8")); }
    catch (error) { fail(`Legacy Observation record contains invalid JSON: ${error.message}`, "INVALID_OBSERVATION_ARTIFACT"); }
    if (!existing?.source || typeof existing.source !== "object") fail("Legacy Observation record source is invalid.", "INVALID_OBSERVATION_ARTIFACT");
    if (sourceReplayKeyDigest(existing.source) === sourceReplayKeyDigest(record.source)) {
      if (observationCanonicalJson(existing) !== observationCanonicalJson(record)) fail(`Create-only Observation key has divergent content: ${path.basename(legacyFile)}`, "DIVERGENT_OBSERVATION_REPLAY");
      return { status: "existing", file: legacyFile };
    }
  }
  return persistCreateOnly(projectRoot, recordDirectory, `${sourceReplayKeyDigest(record.source)}.json`, record, "DIVERGENT_OBSERVATION_REPLAY");
}

export function loadObservationArtifacts({ projectRoot, projectId, storage = null } = {}) {
  storage = formatForVerifiedOwner(storage);
  const descriptors = readDirectory(projectRoot, relativeProjectArtifact(storage, "observations", "descriptors"), "ObservationTypeDescriptor");
  const descriptorsById = descriptorMap(descriptors, storage);
  const observations = readDirectory(projectRoot, relativeProjectArtifact(storage, "observations", "records", "by-source-key"), "ObservationRecord").map((record) => {
    const descriptor = descriptorsById.get(record.descriptorId);
    if (!descriptor) fail("ObservationRecord references an unknown descriptor.", "UNKNOWN_OBSERVATION_DESCRIPTOR");
    return verifyObservationRecord(record, descriptor, projectId, storage);
  });
  const observationIds = new Map();
  const sourceKeys = new Map();
  for (const record of observations) {
    if (observationIds.has(record.observationId)) fail("Duplicate ObservationRecord.", "DUPLICATE_OBSERVATION_RECORD");
    const replayKeyDigest = sourceReplayKeyDigest(record.source);
    const existing = sourceKeys.get(replayKeyDigest);
    if (existing && existing !== record.observationId) fail("Observation source key has divergent records.", "DIVERGENT_OBSERVATION_REPLAY");
    observationIds.set(record.observationId, record);
    sourceKeys.set(replayKeyDigest, record.observationId);
  }
  const derivedObservations = readDirectory(projectRoot, relativeProjectArtifact(storage, "observations", "derived"), "DerivedObservationRecord").map((record) => {
    const descriptor = descriptorsById.get(record.descriptorId);
    if (!descriptor) fail("DerivedObservationRecord references an unknown descriptor.", "UNKNOWN_OBSERVATION_DESCRIPTOR");
    verifyDerivedObservationRecord(record, descriptor, projectId, storage);
    for (const input of record.inputObservations) {
      const source = observationIds.get(input.observationId);
      if (!source || source.observationHash !== input.observationHash) fail("DerivedObservationRecord input is missing or changed.", "DERIVED_OBSERVATION_INPUT_MISMATCH");
    }
    return record;
  });
  const receipts = readDirectory(projectRoot, relativeProjectArtifact(storage, "observations", "receipts"), "ObservationCollectionReceipt").map((receipt) => verifyObservationCollectionReceipt(receipt, projectId, storage));
  const receiptObservationIds = new Set();
  for (const receipt of receipts) {
    const record = observationIds.get(receipt.observationId);
    if (!record || record.observationHash !== receipt.observationHash || record.descriptorId !== receipt.descriptorId
      || record.protocol.name !== receipt.protocol.name) fail("ObservationCollectionReceipt lineage is invalid.", "INVALID_OBSERVATION_RECEIPT_LINEAGE");
    if (receiptObservationIds.has(receipt.observationId)) fail("ObservationRecord has multiple collection receipts.", "DUPLICATE_OBSERVATION_RECEIPT");
    receiptObservationIds.add(receipt.observationId);
  }
  for (const record of observations) if (!receiptObservationIds.has(record.observationId)) fail("ObservationRecord lacks its collection receipt.", "OBSERVATION_RECEIPT_MISSING");
  return {
    descriptors: descriptors.sort((a, b) => a.descriptorId.localeCompare(b.descriptorId)),
    observations: observations.sort((a, b) => a.observationId.localeCompare(b.observationId)),
    derivedObservations: derivedObservations.sort((a, b) => a.derivedObservationId.localeCompare(b.derivedObservationId)),
    receipts: receipts.sort((a, b) => a.receiptId.localeCompare(b.receiptId)),
  };
}

export function registerObservationType({ root = ".", descriptor } = {}) {
  const inspected = assertObservationProjectReady(root);
  const normalized = descriptor?.kind === "ObservationTypeDescriptor" ? verifyObservationTypeDescriptor(descriptor, inspected.storage) : createObservationTypeDescriptor(descriptor, inspected.storage);
  const persisted = persistCreateOnly(inspected.project.projectRoot, relativeProjectArtifact(inspected.storage, "observations", "descriptors"), `${normalized.descriptorId}.json`, normalized);
  return { ...persisted, descriptor: normalized };
}

function recordCollectedObservationInternal({ root = ".", descriptor, input, adapterDescriptor, sourceScopeDigest } = {}) {
  const inspected = assertObservationProjectReady(root);
  const registered = registerObservationType({ root: inspected.project.projectRoot, descriptor }).descriptor;
  const record = createObservationRecord({
    projectId: inspected.project.projectId,
    descriptor: registered,
    subject: input.subject,
    form: input.form,
    temporalScope: input.temporalScope,
    coverage: input.coverage,
    payload: input.payload,
    source: {
      adapterKey: adapterDescriptor.adapterKey,
      adapterVersion: adapterDescriptor.adapterVersion,
      sourceScopeDigest,
      sourceEventKeyDigest: input.sourceEventKeyDigest,
      sourceEvidenceDigest: input.sourceEvidenceDigest,
    },
  }, inspected.storage);
  const recordPersisted = persistObservationRecord(inspected.project.projectRoot, record, inspected.storage);
  const receiptPayload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationCollectionReceipt",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-observation"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId: inspected.project.projectId,
    observationId: record.observationId,
    observationHash: record.observationHash,
    descriptorId: registered.descriptorId,
    adapterKey: adapterDescriptor.adapterKey,
    adapterVersion: adapterDescriptor.adapterVersion,
    adapterDescriptorDigest: observationDigest(adapterDescriptor),
    sourceScopeDigest,
    authority: "collection-evidence-not-source-or-product-authority",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const receipt = verifyObservationCollectionReceipt(receiptIdentity(receiptPayload), inspected.project.projectId, inspected.storage);
  const receiptPersisted = persistCreateOnly(inspected.project.projectRoot, relativeProjectArtifact(inspected.storage, "observations", "receipts"), `${receipt.receiptId}.json`, receipt);
  noteProjectGraphChange(inspected.project.projectRoot, [
    `${relativeProjectArtifact(inspected.storage, "observations", "descriptors")}/${registered.descriptorId}.json`,
    path.relative(inspected.project.projectRoot, recordPersisted.file).replaceAll("\\", "/"),
    path.relative(inspected.project.projectRoot, receiptPersisted.file).replaceAll("\\", "/"),
  ]);
  return { status: recordPersisted.status === "existing" && receiptPersisted.status === "existing" ? "existing" : "recorded", descriptor: registered, observation: record, receipt };
}

export function recordCollectedObservation({ root = ".", descriptor, input, adapterDescriptor, sourceScopeDigest } = {}) {
  const verifiedDescriptor = descriptor?.kind === "ObservationTypeDescriptor"
    ? verifyObservationTypeDescriptor(descriptor)
    : createObservationTypeDescriptor(descriptor);
  if (verifiedDescriptor.typeKey === "delivery.state") {
    fail(
      "delivery.state is a Core-owned Observation specialization; use the dedicated delivery writer so exact revision bindings are verified.",
      "RESERVED_OBSERVATION_TYPE_REQUIRES_SPECIALIZED_WRITER",
    );
  }
  return recordCollectedObservationInternal({ root, descriptor: descriptor?.kind === "ObservationTypeDescriptor" ? verifiedDescriptor : descriptor, input, adapterDescriptor, sourceScopeDigest });
}

async function recordDeliveryCollectedObservationUncoordinated({ root = ".", descriptor, input, adapterDescriptor, sourceScopeDigest } = {}) {
  const inspected = assertObservationProjectReady(root);
  const verifiedDescriptor = descriptor?.kind === "ObservationTypeDescriptor"
    ? verifyObservationTypeDescriptor(descriptor)
    : createObservationTypeDescriptor(descriptor, inspected.storage);
  if (verifiedDescriptor.typeKey !== "delivery.state") {
    fail("The dedicated delivery writer only accepts delivery.state.", "INVALID_SPECIALIZED_OBSERVATION_TYPE");
  }
  const payload = input?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("Delivery Observation payload is invalid.", "INVALID_DELIVERY_REVISION_BINDING");
  }
  const boundFields = ["bound_world_model_id", "bound_revision_id", "bound_logical_entity_id", "bound_source_path"];
  if (payload.revision_binding === "declared") {
    if (boundFields.some((field) => Object.hasOwn(payload, field))) {
      fail("Declared delivery revisions cannot contain verified source-revision fields.", "INVALID_DELIVERY_REVISION_BINDING");
    }
  } else if (payload.revision_binding === "verified-source-revision") {
    if (boundFields.some((field) => typeof payload[field] !== "string" || !payload[field])) {
      fail("Verified delivery revisions require every exact source-revision field.", "INVALID_DELIVERY_REVISION_BINDING");
    }
    const { readWorldModelSnapshot } = await import("./world-model.mjs");
    const snapshot = (await readWorldModelSnapshot({
      root: inspected.project.projectRoot,
      worldModelId: payload.bound_world_model_id,
    })).snapshot;
    const revision = snapshot.temporalProvenanceGraph?.nodes.find((node) => node.nodeId === payload.bound_revision_id);
    if (!revision || revision.kind !== "FileRevision"
      || revision.logicalEntityId !== payload.bound_logical_entity_id
      || revision.path !== payload.bound_source_path
      || revision.digest !== payload.revision_digest) {
      fail(
        "Verified delivery revision binding does not match the retained World Model source revision.",
        "INVALID_DELIVERY_REVISION_BINDING",
      );
    }
  } else {
    fail("Delivery revision binding must be declared or verified-source-revision.", "INVALID_DELIVERY_REVISION_BINDING");
  }
  return recordCollectedObservationInternal({
    root: inspected.project.projectRoot,
    descriptor: verifiedDescriptor,
    input,
    adapterDescriptor,
    sourceScopeDigest,
  });
}

export function recordDerivedObservation({ root = ".", descriptor, input } = {}) {
  const inspected = assertObservationProjectReady(root);
  const registered = registerObservationType({ root: inspected.project.projectRoot, descriptor }).descriptor;
  const current = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const byId = new Map(current.observations.map((record) => [record.observationId, record]));
  const inputs = (input.inputObservationIds || []).map((id) => {
    const record = byId.get(id);
    if (!record) fail(`Derived Observation input not found: ${id}`, "OBSERVATION_NOT_FOUND");
    return { observationId: record.observationId, observationHash: record.observationHash };
  });
  const derived = createDerivedObservationRecord({ projectId: inspected.project.projectId, descriptor: registered, subject: input.subject, temporalScope: input.temporalScope, inputObservations: inputs, algorithm: input.algorithm, coverage: input.coverage, payload: input.payload }, inspected.storage);
  const persisted = persistCreateOnly(inspected.project.projectRoot, relativeProjectArtifact(inspected.storage, "observations", "derived"), `${derived.derivedObservationId}.json`, derived);
  noteProjectGraphChange(inspected.project.projectRoot, [`${relativeProjectArtifact(inspected.storage, "observations", "descriptors")}/${registered.descriptorId}.json`,
    path.relative(inspected.project.projectRoot, persisted.file).replaceAll("\\", "/")]);
  return { ...persisted, descriptor: registered, derivedObservation: derived };
}

export function readObservation({ root = ".", observationId } = {}) {
  const inspected = assertObservationProjectReady(root);
  const artifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const observation = artifacts.observations.find((item) => item.observationId === observationId) || null;
  const derivedObservation = artifacts.derivedObservations.find((item) => item.derivedObservationId === observationId) || null;
  if (!observation && !derivedObservation) fail(`Observation not found: ${observationId}`, "OBSERVATION_NOT_FOUND");
  const selected = observation || derivedObservation;
  const descriptor = artifacts.descriptors.find((item) => item.descriptorId === selected.descriptorId) || null;
  const receipt = observation ? artifacts.receipts.find((item) => item.observationId === observation.observationId) || null : null;
  return {
    status: "verified",
    projectId: inspected.project.projectId,
    observation: selected,
    descriptor,
    receipt,
    lineage: observation
      ? { kind: "collected", receiptId: receipt.receiptId, descriptorId: descriptor.descriptorId }
      : { kind: "derived", descriptorId: descriptor.descriptorId, inputObservationIds: selected.inputObservations.map((item) => item.observationId) },
  };
}

export async function recordDeliveryCollectedObservation(options = {}, ...rest) {
  return withSnapshotReferencesAsync({ root: options.root ?? ".", storage: options.storage }, () => recordDeliveryCollectedObservationUncoordinated(options, ...rest));
}
