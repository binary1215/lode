import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import { inspectRequiredIndex } from "./arcadedb-schema-contract.mjs";
import {
  ARCADEDB_GRAPH_RESERVED_SCHEMA,
  arcadeDbGraphReservedSchemaFor,
  ArcadeDbHttpTransport,
  inspectArcadeDbGraphProjectionActivation,
} from "./graph-projection-adapter.mjs";

export const ARCADEDB_DATABASE_LIFECYCLE_VERSION = "0.2.0";
function lifecycleArtifact(storage, ...segments) {
  return relativeProjectArtifact(storage, "graph-projection", "arcadedb", "database-lifecycle", ...segments);
}
function activationPointers(storage) {
  return [
    relativeProjectArtifact(storage, "graph-projection", "arcadedb", "current.json"),
    relativeProjectArtifact(storage, "graph-projection", "arcadedb", "topology", "current.json"),
    relativeProjectArtifact(storage, "graph-projection", "arcadedb", "sync", "current.json"),
  ];
}

const fail = (message, code = "ARCADEDB_DATABASE_LIFECYCLE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function configuredSelection(projectRoot, storage) {
  const configured = inspectArcadeDbGraphProjectionActivation({ projectRoot, storage });
  if (!configured.storageSelection || configured.storageSelection.mode !== "graphdb") {
    fail("Onboarding must select GraphDB before database lifecycle inspection.", "ARCADEDB_SELECTION_REQUIRED");
  }
  return configured.storageSelection;
}

function assertLifecycleTransport(transport) {
  for (const method of ["ready", "databaseExists", "createDatabase", "dropDatabase", "readSchemaTypes"]) {
    if (typeof transport?.[method] !== "function") fail(`ArcadeDB lifecycle transport is missing ${method}().`, "INVALID_ARCADEDB_LIFECYCLE_TRANSPORT");
  }
  return transport;
}

function normalizedProperties(value) {
  if (!Array.isArray(value)) return new Map();
  const result = new Map();
  for (const property of value) {
    if (!property || typeof property !== "object" || Array.isArray(property)
      || typeof property.name !== "string" || typeof property.type !== "string") continue;
    result.set(property.name, property.type.toUpperCase());
  }
  return result;
}

function compatibilityFor(records, storage) {
  const reservedSchema = arcadeDbGraphReservedSchemaFor(storage);
  if (!Array.isArray(records)) fail("ArcadeDB schema inspection returned an invalid result.", "ARCADEDB_INVALID_RESPONSE");
  const byName = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.name !== "string") {
      fail("ArcadeDB schema inspection returned an invalid type record.", "ARCADEDB_INVALID_RESPONSE");
    }
    if (byName.has(record.name)) fail("ArcadeDB schema inspection returned duplicate type names.", "ARCADEDB_INVALID_RESPONSE");
    byName.set(record.name, record);
  }
  const conflicts = [];
  // A new namespace must not adopt or migrate the existing HEAD DB schema.
  if (formatForVerifiedOwner(storage).dialect === "lode") {
    for (const legacy of ARCADEDB_GRAPH_RESERVED_SCHEMA) {
      if (byName.has(legacy.name)) conflicts.push({
        reservedType: formatForVerifiedOwner(storage).kind(legacy.name),
        field: "namespace", expected: "lode-reserved-schema", observed: "legacy-reserved-schema",
      });
    }
  }
  const unverifiable = [];
  const indexChecks = [];
  let missingIndexCount = 0;
  const reservedTypesPresent = [];
  let missingPropertyCount = 0;
  for (const expected of reservedSchema) {
    const observed = byName.get(expected.name);
    if (!observed) continue;
    reservedTypesPresent.push(expected.name);
    const observedType = String(observed.type || "").toLowerCase();
    // Bind only metadata used for HEAD's reserved write contract. Array order
    // is immaterial for definitions, but the order of a composite key is not.
    const fieldEvidence = (value, fields) => Object.fromEntries(fields.map((key) => [key, value?.[key] ?? null]));
    const sortEvidence = (items) => items.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    const schemaEvidence = {
      type: observedType,
      indexes: Array.isArray(observed.indexes) ? sortEvidence(observed.indexes.map((index) => fieldEvidence(index, ["properties", "unique", "status"]))) : null,
      properties: Array.isArray(observed.properties) ? sortEvidence(observed.properties.map((property) => fieldEvidence(property, ["name", "type", "mandatory", "notNull", "readonly", "readOnly", "min", "max", "regexp"]))) : null,
    };
    const index = inspectRequiredIndex(observed);
    indexChecks.push({ reservedType: expected.name, ...index, schemaEvidence });
    if (observedType !== expected.type) {
      conflicts.push({ reservedType: expected.name, field: "type", expected: expected.type, observed: observedType || "missing" });
      continue;
    }
    const properties = normalizedProperties(observed.properties);
    if (!Array.isArray(observed.properties) || properties.size !== observed.properties.length) unverifiable.push({ reservedType: expected.name, reason: "property-metadata-incomplete" });
    if (index.status === "missing") missingIndexCount++;
    if (index.status === "unverifiable") unverifiable.push({ reservedType: expected.name, reason: index.reason });
    if (index.status === "conflict") conflicts.push({ reservedType: expected.name, field: "unique-index", expected: "exact-head-key-unique", observed: index.reason });
    for (const property of Array.isArray(observed.properties) ? observed.properties : []) {
      if (!property || typeof property.name !== "string") continue;
      const supplied = Object.hasOwn(expected.properties, property.name);
      if ((!supplied && (property.mandatory === true || property.notNull === true))
        || (supplied && (property.readonly === true || property.readOnly === true))) {
        conflicts.push({ reservedType: expected.name, field: `constraint:${property.name}`, expected: "head-write-compatible", observed: "required-extra-field-or-readonly-head-field" });
      }
      if (supplied && ["min", "max", "regexp"].some((key) => property[key] != null)) unverifiable.push({ reservedType: expected.name, reason: `write-constraint:${property.name}` });
    }
    for (const [propertyName, propertyType] of Object.entries(expected.properties)) {
      if (!properties.has(propertyName)) missingPropertyCount += 1;
      else if (properties.get(propertyName) !== propertyType) {
        conflicts.push({ reservedType: expected.name, field: `property:${propertyName}`, expected: propertyType, observed: properties.get(propertyName) });
      }
    }
  }
  conflicts.sort((left, right) => left.reservedType.localeCompare(right.reservedType) || left.field.localeCompare(right.field));
  reservedTypesPresent.sort();
  return {
    conflicts,
    unverifiable,
    indexChecks,
    missingIndexCount,
    reservedTypesPresent,
    missingReservedTypeCount: reservedSchema.length - reservedTypesPresent.length,
    missingPropertyCount,
    unrelatedTypeCount: [...byName.keys()].filter((name) => !reservedSchema.some((item) => item.name === name)).length,
  };
}

function auditIdentity(payload) {
  const auditHash = digest(canonicalJson(payload));
  return verifyArcadeDbDatabaseCompatibilityAudit({ ...payload, auditId: `arcadedb-database-audit-${auditHash.slice(0, 24)}`, auditHash });
}

export function verifyArcadeDbDatabaseCompatibilityAudit(document) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-database-lifecycle", document);
  if (!document || document.kind !== "ArcadeDbDatabaseCompatibilityAudit" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_DATABASE_LIFECYCLE_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^[a-f0-9]{64}$/.test(document.storageSelectionHash || "")
    || !new Set(["database-missing", "compatible-empty-reserved-schema", "compatible-partial-reserved-schema", "compatible-complete-reserved-schema", "incompatible-reserved-schema", "unverifiable-reserved-schema"]).has(document.status)
    || typeof document.databaseExists !== "boolean" || typeof document.canActivateWithoutReset !== "boolean"
    || typeof document.resetEligible !== "boolean" || !Array.isArray(document.conflicts)
    || !Array.isArray(document.reservedTypesPresent)
    || !Array.isArray(document.unverifiable) || !Array.isArray(document.indexChecks)
    || !Number.isInteger(document.missingIndexCount) || document.missingIndexCount < 0
    || document.canActivateNow !== (document.status === "compatible-complete-reserved-schema")
    || !Number.isInteger(document.missingReservedTypeCount) || document.missingReservedTypeCount < 0
    || !Number.isInteger(document.missingPropertyCount) || document.missingPropertyCount < 0
    || !Number.isInteger(document.unrelatedTypeCount) || document.unrelatedTypeCount < 0
    || document.credentialValuesPersisted !== false || document.targetValuePersisted !== false
    || document.authority !== "derived-operational-evidence-only"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^arcadedb-database-audit-[a-f0-9]{24}$/.test(document.auditId || "")
    || !/^[a-f0-9]{64}$/.test(document.auditHash || "")) {
    fail("ArcadeDB database compatibility audit is invalid.", "INVALID_ARCADEDB_DATABASE_COMPATIBILITY_AUDIT");
  }
  const compatible = document.status.startsWith("compatible-");
  const expectedExists = document.status !== "database-missing";
  const expectedResetEligible = document.status === "incompatible-reserved-schema";
  const reservedNames = new Set(arcadeDbGraphReservedSchemaFor(format).map((item) => item.name));
  if (document.databaseExists !== expectedExists || document.canActivateWithoutReset !== compatible
    || document.resetEligible !== expectedResetEligible
    || (document.status === "unverifiable-reserved-schema" && (document.unverifiable.length === 0 || document.conflicts.length !== 0))
    || (document.status === "compatible-complete-reserved-schema" && (document.missingIndexCount || document.missingReservedTypeCount || document.missingPropertyCount || document.unverifiable.length))
    || (expectedResetEligible !== (document.conflicts.length > 0))
    || new Set(document.reservedTypesPresent).size !== document.reservedTypesPresent.length
    || document.reservedTypesPresent.some((name) => !reservedNames.has(name))
    || canonicalJson(document.reservedTypesPresent) !== canonicalJson([...document.reservedTypesPresent].sort())
    || document.conflicts.some((item) => !item || typeof item !== "object" || Array.isArray(item)
      || !reservedNames.has(item.reservedType) || typeof item.field !== "string" || !item.field
      || typeof item.expected !== "string" || !item.expected || typeof item.observed !== "string" || !item.observed)) {
    fail("ArcadeDB database compatibility audit state is inconsistent.", "INVALID_ARCADEDB_DATABASE_COMPATIBILITY_AUDIT");
  }
  const payload = { ...document };
  delete payload.auditId;
  delete payload.auditHash;
  const hash = digest(canonicalJson(payload));
  if (document.auditHash !== hash || document.auditId !== `arcadedb-database-audit-${hash.slice(0, 24)}`) {
    fail("ArcadeDB database compatibility audit digest verification failed.", "ARCADEDB_DATABASE_AUDIT_DIGEST_MISMATCH");
  }
  return document;
}

export function inspectArcadeDbDatabaseCompatibility({ root = ".", transport = null, storage = null } = {}) {
  const format = formatForVerifiedOwner(storage);
  const reservedSchema = arcadeDbGraphReservedSchemaFor(storage);
  const projectRoot = path.resolve(root);
  const storageSelection = configuredSelection(projectRoot, storage);
  const selectedTransport = assertLifecycleTransport(transport || new ArcadeDbHttpTransport({ storageSelection, storage }));
  selectedTransport.ready();
  const exists = selectedTransport.databaseExists();
  const compatibility = exists ? compatibilityFor(selectedTransport.readSchemaTypes(), storage) : {
    conflicts: [],
    unverifiable: [], indexChecks: [], missingIndexCount: 0,
    reservedTypesPresent: [],
    missingReservedTypeCount: reservedSchema.length,
    missingPropertyCount: Object.values(reservedSchema).reduce((sum, item) => sum + Object.keys(item.properties).length, 0),
    unrelatedTypeCount: 0,
  };
  const status = !exists
    ? "database-missing"
    : compatibility.conflicts.length > 0
      ? "incompatible-reserved-schema"
      : compatibility.unverifiable.length > 0
        ? "unverifiable-reserved-schema"
      : compatibility.reservedTypesPresent.length === 0
        ? "compatible-empty-reserved-schema"
        : compatibility.missingReservedTypeCount > 0 || compatibility.missingPropertyCount > 0 || compatibility.missingIndexCount > 0
          ? "compatible-partial-reserved-schema"
          : "compatible-complete-reserved-schema";
  return auditIdentity({
    schemaVersion: 1,
    kind: "ArcadeDbDatabaseCompatibilityAudit",
    protocol: { name: format.protocol("head-agent-core-arcadedb-database-lifecycle"), version: ARCADEDB_DATABASE_LIFECYCLE_VERSION },
    projectId: storageSelection.projectId,
    storageSelectionId: storageSelection.storageSelectionId,
    storageSelectionHash: storageSelection.storageSelectionHash,
    status,
    databaseExists: exists,
    // Compatibility here permits bounded provisioning, not immediate writes.
    canActivateWithoutReset: status.startsWith("compatible-"),
    canActivateNow: status === "compatible-complete-reserved-schema",
    resetEligible: exists && compatibility.conflicts.length > 0,
    ...compatibility,
    credentialValuesPersisted: false,
    targetValuePersisted: false,
    authority: "derived-operational-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  });
}

function invalidateActivationPointers(projectRoot, storage) {
  const invalidated = [];
  for (const relative of activationPointers(storage)) {
    const file = path.join(projectRoot, relative);
    if (!fs.existsSync(file)) continue;
    fs.unlinkSync(file);
    invalidated.push(relative.replaceAll("\\", "/"));
  }
  return invalidated;
}

function receiptFor({ storageSelection, before, after, action, invalidatedPointers, storage }) {
  const format = formatForVerifiedOwner(storage);
  const payload = {
    schemaVersion: 1,
    kind: "ArcadeDbDatabaseLifecycleReceipt",
    protocol: { name: format.protocol("head-agent-core-arcadedb-database-lifecycle"), version: ARCADEDB_DATABASE_LIFECYCLE_VERSION },
    projectId: storageSelection.projectId,
    storageSelectionId: storageSelection.storageSelectionId,
    storageSelectionHash: storageSelection.storageSelectionHash,
    beforeAuditId: before.auditId,
    beforeAuditHash: before.auditHash,
    afterAuditId: after.auditId,
    afterAuditHash: after.auditHash,
    action,
    invalidatedRemoteActivationPointerCount: invalidatedPointers.length,
    credentialValuesPersisted: false,
    targetValuePersisted: false,
    authority: "external-operation-evidence-not-project-canon",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const receiptHash = digest(canonicalJson(payload));
  return verifyArcadeDbDatabaseLifecycleReceipt({ ...payload, receiptId: `arcadedb-database-lifecycle-${receiptHash.slice(0, 24)}`, receiptHash });
}

export function verifyArcadeDbDatabaseLifecycleReceipt(document) {
  const format = familyFormatForOriginal("head-agent-core-arcadedb-database-lifecycle", document);
  if (!document || document.kind !== "ArcadeDbDatabaseLifecycleReceipt" || document.schemaVersion !== 1
    || !format
    || document.protocol?.version !== ARCADEDB_DATABASE_LIFECYCLE_VERSION
    || typeof document.projectId !== "string" || !document.projectId
    || !/^onboarding-storage-[a-f0-9]{24}$/.test(document.storageSelectionId || "")
    || !/^[a-f0-9]{64}$/.test(document.storageSelectionHash || "")
    || !/^arcadedb-database-audit-[a-f0-9]{24}$/.test(document.beforeAuditId || "")
    || !/^arcadedb-database-audit-[a-f0-9]{24}$/.test(document.afterAuditId || "")
    || !/^[a-f0-9]{64}$/.test(document.beforeAuditHash || "") || !/^[a-f0-9]{64}$/.test(document.afterAuditHash || "")
    || !new Set(["reused-compatible-database", "created-missing-database", "reset-incompatible-database"]).has(document.action)
    || !Number.isInteger(document.invalidatedRemoteActivationPointerCount) || document.invalidatedRemoteActivationPointerCount < 0
    || document.credentialValuesPersisted !== false || document.targetValuePersisted !== false
    || document.authority !== "external-operation-evidence-not-project-canon"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^arcadedb-database-lifecycle-[a-f0-9]{24}$/.test(document.receiptId || "")
    || !/^[a-f0-9]{64}$/.test(document.receiptHash || "")) {
    fail("ArcadeDB database lifecycle receipt is invalid.", "INVALID_ARCADEDB_DATABASE_LIFECYCLE_RECEIPT");
  }
  const payload = { ...document };
  delete payload.receiptId;
  delete payload.receiptHash;
  const hash = digest(canonicalJson(payload));
  if (document.receiptHash !== hash || document.receiptId !== `arcadedb-database-lifecycle-${hash.slice(0, 24)}`) {
    fail("ArcadeDB database lifecycle receipt digest verification failed.", "ARCADEDB_DATABASE_LIFECYCLE_RECEIPT_DIGEST_MISMATCH");
  }
  return document;
}

function persistReceipt(projectRoot, receipt, audits, storage) {
  verifyArcadeDbDatabaseLifecycleReceipt(receipt);
  for (const audit of audits) {
    verifyArcadeDbDatabaseCompatibilityAudit(audit);
    const auditFile = path.join(projectRoot, lifecycleArtifact(storage, "audits"), `${audit.auditId}.json`);
    if (fs.existsSync(auditFile)) {
      const existing = verifyArcadeDbDatabaseCompatibilityAudit(JSON.parse(fs.readFileSync(auditFile, "utf8")));
      if (canonicalJson(existing) !== canonicalJson(audit)) fail("ArcadeDB database compatibility audit conflicts with existing content.", "ARCADEDB_DATABASE_AUDIT_CONFLICT");
    } else atomicWrite(auditFile, json(audit));
  }
  const file = path.join(projectRoot, lifecycleArtifact(storage, "receipts"), `${receipt.receiptId}.json`);
  if (fs.existsSync(file)) {
    const existing = verifyArcadeDbDatabaseLifecycleReceipt(JSON.parse(fs.readFileSync(file, "utf8")));
    if (canonicalJson(existing) !== canonicalJson(receipt)) fail("ArcadeDB database lifecycle receipt conflicts with existing content.", "ARCADEDB_DATABASE_LIFECYCLE_RECEIPT_CONFLICT");
  } else atomicWrite(file, json(receipt));
  const pointerPayload = {
    schemaVersion: 1,
    kind: "ArcadeDbDatabaseLifecyclePointer",
    protocol: receipt.protocol,
    projectId: receipt.projectId,
    storageSelectionId: receipt.storageSelectionId,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    credentialValuesPersisted: false,
    targetValuePersisted: false,
  };
  const pointerHash = digest(canonicalJson(pointerPayload));
  atomicWrite(path.join(projectRoot, lifecycleArtifact(storage, "current.json")), json({ ...pointerPayload, pointerId: `arcadedb-database-lifecycle-pointer-${pointerHash.slice(0, 24)}`, pointerHash }));
  return { receipt };
}

export function initializeArcadeDbDatabase({ root = ".", resetIncompatible = false, confirmDatabase = "", transport = null, storage = null } = {}) {
  const projectRoot = path.resolve(root);
  const storageSelection = configuredSelection(projectRoot, storage);
  const selectedTransport = assertLifecycleTransport(transport || new ArcadeDbHttpTransport({ storageSelection, storage }));
  const before = inspectArcadeDbDatabaseCompatibility({ root: projectRoot, transport: selectedTransport, storage });
  if (before.status === "unverifiable-reserved-schema") fail("Inspect the required HEAD schema metadata; uncertainty does not justify database reset.", "ARCADEDB_SCHEMA_UNVERIFIED");
  let action = "reused-compatible-database";
  let invalidatedPointers = [];
  if (before.status === "database-missing") {
    invalidatedPointers = invalidateActivationPointers(projectRoot, storage);
    selectedTransport.createDatabase();
    action = "created-missing-database";
  } else if (before.status === "incompatible-reserved-schema") {
    if (resetIncompatible !== true) {
      fail("Inspect or repair the conflicting HEAD reserved schema without changing unrelated data. A full reset requires a separate exact-target destructive request.", "ARCADEDB_DATABASE_RESET_CONFIRMATION_REQUIRED");
    }
    if (typeof confirmDatabase !== "string" || confirmDatabase !== storageSelection.graphdb.database) {
      fail("ArcadeDB reset confirmation does not exactly match the selected database.", "ARCADEDB_DATABASE_RESET_TARGET_MISMATCH");
    }
    invalidatedPointers = invalidateActivationPointers(projectRoot, storage);
    selectedTransport.dropDatabase();
    selectedTransport.createDatabase();
    action = "reset-incompatible-database";
  }
  const after = inspectArcadeDbDatabaseCompatibility({ root: projectRoot, transport: selectedTransport, storage });
  if (!after.databaseExists || after.conflicts.length > 0) {
    fail("ArcadeDB database initialization did not produce a compatible target.", "ARCADEDB_DATABASE_INITIALIZATION_FAILED");
  }
  const receipt = receiptFor({ storageSelection, before, after, action, invalidatedPointers, storage });
  return {
    status: "compatible-ready-for-activation",
    action,
    before,
    after,
    ...persistReceipt(projectRoot, receipt, [before, after], storage),
    credentialsPersisted: false,
    targetValuePersisted: false,
  };
}
