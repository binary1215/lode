import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./head-core.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import { readIncrementalRefreshReceipt, readPostRefreshProjectionReceipt, refreshWorldModel } from "./incremental-refresh.mjs";
import { inspectRefreshWriterLease, withRefreshWriterLease } from "./refresh-writer-lease.mjs";
import { managedRootFilesForProject, REPOSITORY_SCAN_EXCLUDED_DIRECTORIES } from "./repository-scan.mjs";
import { inspectWorldModel, readWorldModel, readWorldModelSnapshot } from "./world-model.mjs";

export const REFRESH_TRIGGER_VERSION = "0.2.0";
const LEGACY_REFRESH_TRIGGER_VERSION = "0.1.0";
export const DEFAULT_REFRESH_DEBOUNCE_MS = 350;
export const DEFAULT_REFRESH_EVENT_LIMIT = 1024;
export const MAX_REFRESH_EVENT_LIMIT = 4096;

const BATCH_PATTERN = /^refresh-trigger-batch-[a-f0-9]{24}$/;
const DELIVERY_PATTERN = /^refresh-trigger-delivery-[a-f0-9]{24}$/;
const SOURCE_KINDS = new Set(["filesystem", "ci"]);
const EVENT_KINDS = new Set(["path-hint", "project-signal"]);
const DISCARD_REASONS = new Set(["duplicate-event", "event-limit-exceeded", "excluded-or-managed-path"]);
const EXCLUDED_DIRECTORIES = new Set(REPOSITORY_SCAN_EXCLUDED_DIRECTORIES);

const fail = (message, code = "REFRESH_TRIGGER_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFields(record, allowed, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} must be an object.`, "INVALID_REFRESH_TRIGGER_SCHEMA");
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_REFRESH_TRIGGER_SCHEMA");
}

function identity(kind, payload) {
  const hash = digest(canonicalJson(payload));
  return { id: `${kind}-${hash.slice(0, 24)}`, hash };
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for refresh trigger ingestion; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

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

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_REFRESH_TRIGGER_DOCUMENT"); }
}

function normalizeEvidenceId(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(value)) fail(`${label} is invalid.`, "INVALID_REFRESH_TRIGGER_EVIDENCE_ID");
  return value;
}

function normalizeOperation(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) fail(`${label} is invalid.`, "INVALID_REFRESH_TRIGGER_OPERATION");
  return value;
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    fail(`${label} is not a project-relative path.`, "INVALID_REFRESH_TRIGGER_PATH");
  }
  const slash = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = path.posix.normalize(slash);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    fail(`${label} escapes the project root.`, "INVALID_REFRESH_TRIGGER_PATH");
  }
  return normalized;
}

function ignoredPath(relativePath, managedRootFiles, storage = null) {
  const segments = relativePath.split("/");
  const ownedManagementSubtree = formatForVerifiedOwner(storage).dialect === "lode"
    && managedRootFiles.includes(".lode")
    && relativePath.startsWith(".lode/");
  return segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment)) || managedRootFiles.includes(relativePath) || ownedManagementSubtree;
}

function normalizeTriggerEvent(event, index, managedRootFiles, storage = null) {
  assertFields(event, ["kind", "operation", "path", "evidenceId"], `events[${index}]`);
  if (!EVENT_KINDS.has(event.kind)) fail(`events[${index}].kind is unsupported.`, "INVALID_REFRESH_TRIGGER_EVENT");
  const operation = normalizeOperation(event.operation, `events[${index}].operation`);
  const evidenceId = normalizeEvidenceId(event.evidenceId, `events[${index}].evidenceId`);
  if (event.kind === "project-signal") {
    if (event.path !== undefined && event.path !== null) fail(`events[${index}].path must be null for a project signal.`, "INVALID_REFRESH_TRIGGER_EVENT");
    return { event: { kind: "project-signal", operation, path: null, evidenceId }, ignored: false };
  }
  const relativePath = normalizeRelativePath(event.path, `events[${index}].path`);
  if (ignoredPath(relativePath, managedRootFiles, storage)) return { event: null, ignored: true };
  return { event: { kind: "path-hint", operation, path: relativePath, evidenceId }, ignored: false };
}

function normalizedSourceKind(sourceKind) {
  if (!SOURCE_KINDS.has(sourceKind)) fail("Refresh trigger source kind must be filesystem or ci.", "INVALID_REFRESH_TRIGGER_SOURCE");
  return sourceKind;
}

function normalizedEventLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REFRESH_EVENT_LIMIT) {
    fail(`Refresh trigger event limit must be an integer from 1 through ${MAX_REFRESH_EVENT_LIMIT}.`, "INVALID_REFRESH_TRIGGER_LIMIT");
  }
  return value;
}

function normalizeDiscardedReasons(counts) {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => compareText(left.reason, right.reason));
}

function addCount(counts, reason, count = 1) {
  if (count > 0) counts.set(reason, (counts.get(reason) || 0) + count);
}

export function buildRefreshTriggerBatch({
  projectId,
  sourceKind,
  events = [],
  managedRootFiles = [],
  maxEvents = DEFAULT_REFRESH_EVENT_LIMIT,
  overflowEventCount = 0,
  overflowRescanRequired = false,
} = {}, storage = null) {
  const format = formatForVerifiedOwner(storage);
  if (typeof projectId !== "string" || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(projectId)) fail("Refresh trigger projectId is invalid.", "INVALID_REFRESH_TRIGGER_SCHEMA");
  const source = normalizedSourceKind(sourceKind);
  const limit = normalizedEventLimit(maxEvents);
  if (!Array.isArray(events) || events.length > 10000) fail("Refresh trigger events must be a bounded array.", "INVALID_REFRESH_TRIGGER_EVENTS");
  if (!Array.isArray(managedRootFiles) || managedRootFiles.some((item) => typeof item !== "string")) fail("managedRootFiles must be an array of paths.", "INVALID_REFRESH_TRIGGER_SCHEMA");
  if (!Number.isInteger(overflowEventCount) || overflowEventCount < 0 || typeof overflowRescanRequired !== "boolean") {
    fail("Refresh trigger overflow diagnostics are invalid.", "INVALID_REFRESH_TRIGGER_SCHEMA");
  }

  const discarded = new Map();
  const unique = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const normalized = normalizeTriggerEvent(events[index], index, managedRootFiles, storage);
    if (normalized.ignored) {
      addCount(discarded, "excluded-or-managed-path");
      continue;
    }
    const key = canonicalJson(normalized.event);
    if (unique.has(key)) addCount(discarded, "duplicate-event");
    else unique.set(key, normalized.event);
  }
  const ordered = [...unique.entries()].sort(([left], [right]) => compareText(left, right)).map(([, event]) => event);
  const acceptedEvents = ordered.slice(0, limit);
  addCount(discarded, "event-limit-exceeded", Math.max(0, ordered.length - limit) + overflowEventCount);
  const discardedReasons = normalizeDiscardedReasons(discarded);
  const droppedEventCount = discardedReasons.filter((item) => item.reason !== "duplicate-event").reduce((total, item) => total + item.count, 0);
  const coalescedEventCount = discarded.get("duplicate-event") || 0;
  const inputEventCount = events.length + overflowEventCount;
  const requiresRescan = acceptedEvents.length > 0 || overflowEventCount > 0;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "RefreshTriggerBatch",
    protocol: { name: format.protocol("head-agent-core-refresh-trigger"), version: REFRESH_TRIGGER_VERSION },
    projectId,
    source: {
      kind: source,
      adapter: source === "filesystem" ? "node-filesystem-watch" : "structured-ci-event-file",
      adapterVersion: REFRESH_TRIGGER_VERSION,
    },
    events: acceptedEvents,
    eventSummary: {
      inputEventCount,
      acceptedEventCount: acceptedEvents.length,
      coalescedEventCount,
      droppedEventCount,
      discardedReasons,
    },
    requiresRescan,
    rescanPolicy: "complete-discovery-read-and-byte-hash; event paths are hints only",
    authority: "observed-refresh-trigger-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutationAuthority: false,
  };
  const batchIdentity = identity("refresh-trigger-batch", payload);
  return { ...payload, triggerBatchId: batchIdentity.id, triggerBatchHash: batchIdentity.hash };
}

export function verifyRefreshTriggerBatch(batch, expectedOwner = null) {
  const format = familyFormatForOriginal("head-agent-core-refresh-trigger", batch, expectedOwner);
  assertFields(batch, ["schemaVersion", "kind", "protocol", "projectId", "source", "events", "eventSummary", "requiresRescan", "rescanPolicy", "authority", "instructionAuthority", "promotionAuthority", "canonMutationAuthority", "triggerBatchId", "triggerBatchHash"], "Refresh trigger batch");
  assertFields(batch.source, ["kind", "adapter", "adapterVersion"], "Refresh trigger source");
  assertFields(batch.eventSummary, ["inputEventCount", "acceptedEventCount", "coalescedEventCount", "droppedEventCount", "discardedReasons"], "Refresh trigger event summary");
  const protocolVersion = batch.protocol?.version;
  if (batch.schemaVersion !== SCHEMA_VERSION || batch.kind !== "RefreshTriggerBatch"
    || !format
    || ![LEGACY_REFRESH_TRIGGER_VERSION, REFRESH_TRIGGER_VERSION].includes(protocolVersion)
    || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(batch.projectId || "") || !BATCH_PATTERN.test(batch.triggerBatchId || "")
    || !SOURCE_KINDS.has(batch.source.kind) || batch.source.adapterVersion !== protocolVersion
    || batch.source.adapter !== (batch.source.kind === "filesystem" ? "node-filesystem-watch" : "structured-ci-event-file")
    || batch.rescanPolicy !== "complete-discovery-read-and-byte-hash; event paths are hints only"
    || batch.authority !== "observed-refresh-trigger-evidence-only" || batch.instructionAuthority !== false
    || batch.promotionAuthority !== false || batch.canonMutationAuthority !== false || typeof batch.requiresRescan !== "boolean") {
    fail("Refresh trigger batch contract is invalid.", "INVALID_REFRESH_TRIGGER_BATCH");
  }
  if (!Array.isArray(batch.events) || batch.events.length > MAX_REFRESH_EVENT_LIMIT) fail("Refresh trigger batch events are invalid.", "INVALID_REFRESH_TRIGGER_BATCH");
  const normalizedEvents = batch.events.map((event, index) => {
    const normalized = normalizeTriggerEvent(event, index, []);
    if (normalized.ignored || !normalized.event) fail("Persisted trigger events cannot be excluded paths.", "INVALID_REFRESH_TRIGGER_BATCH");
    return normalized.event;
  });
  const orderedEvents = [...normalizedEvents].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  if (canonicalJson(orderedEvents) !== canonicalJson(batch.events) || new Set(orderedEvents.map(canonicalJson)).size !== orderedEvents.length) {
    fail("Refresh trigger batch events are not unique and canonically ordered.", "INVALID_REFRESH_TRIGGER_BATCH");
  }
  const summary = batch.eventSummary;
  const counts = [summary.inputEventCount, summary.acceptedEventCount, summary.coalescedEventCount, summary.droppedEventCount];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0) || summary.acceptedEventCount !== batch.events.length
    || summary.inputEventCount !== summary.acceptedEventCount + summary.coalescedEventCount + summary.droppedEventCount) {
    fail("Refresh trigger event counts are inconsistent.", "INVALID_REFRESH_TRIGGER_BATCH");
  }
  if (!Array.isArray(summary.discardedReasons)) fail("Refresh trigger discarded reasons are invalid.", "INVALID_REFRESH_TRIGGER_BATCH");
  const reasons = summary.discardedReasons.map((item) => {
    assertFields(item, ["reason", "count"], "Refresh trigger discard reason");
    if (!DISCARD_REASONS.has(item.reason) || !Number.isInteger(item.count) || item.count <= 0) fail("Refresh trigger discard reason is invalid.", "INVALID_REFRESH_TRIGGER_BATCH");
    return item;
  });
  if (canonicalJson([...reasons].sort((left, right) => compareText(left.reason, right.reason))) !== canonicalJson(reasons)
    || new Set(reasons.map((item) => item.reason)).size !== reasons.length
    || reasons.filter((item) => item.reason === "duplicate-event").reduce((total, item) => total + item.count, 0) !== summary.coalescedEventCount
    || reasons.filter((item) => item.reason !== "duplicate-event").reduce((total, item) => total + item.count, 0) !== summary.droppedEventCount) {
    fail("Refresh trigger discarded reasons do not match their counts.", "INVALID_REFRESH_TRIGGER_BATCH");
  }
  const overflowCount = reasons.find((item) => item.reason === "event-limit-exceeded")?.count || 0;
  if (batch.requiresRescan !== (batch.events.length > 0 || overflowCount > 0)) fail("Refresh trigger rescan disposition is invalid.", "INVALID_REFRESH_TRIGGER_BATCH");
  const payload = { ...batch };
  delete payload.triggerBatchId;
  delete payload.triggerBatchHash;
  const hash = digest(canonicalJson(payload));
  if (batch.triggerBatchHash !== hash || batch.triggerBatchId !== `refresh-trigger-batch-${hash.slice(0, 24)}`) {
    fail("Refresh trigger batch identity verification failed.", "REFRESH_TRIGGER_BATCH_DIGEST_MISMATCH");
  }
  return batch;
}

function snapshotBinding(snapshot) {
  return {
    worldModelId: snapshot.worldModelId,
    sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
    graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
  };
}

function buildDelivery({ batch, status, base, next, refreshRequestId = null, refreshReceiptId = null, postRefreshProjection = null }) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "RefreshTriggerDeliveryReceipt",
    protocol: batch.protocol,
    projectId: batch.projectId,
    triggerBatchId: batch.triggerBatchId,
    triggerBatchHash: batch.triggerBatchHash,
    sourceKind: batch.source.kind,
    status,
    base,
    next,
    incrementalRefresh: { refreshRequestId, refreshReceiptId },
    serialization: "exclusive-project-world-model-writer-lease-and-expected-pointer-check",
    projectionDisposition: {
      graph: status === "ignored" ? "unchanged" : "verified-by-incremental-refresh",
      documents: status === "ignored" ? {
        status: "not-evaluated-no-refresh",
        postRefreshProjectionReceiptId: null,
        policyId: null,
      } : {
        status: postRefreshProjection.receipt.outcome.status,
        postRefreshProjectionReceiptId: postRefreshProjection.receipt.postRefreshProjectionReceiptId,
        policyId: postRefreshProjection.receipt.policy?.policyId || null,
      },
    },
    authority: "verified-refresh-trigger-delivery-evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    canonMutation: "none",
  };
  const deliveryIdentity = identity("refresh-trigger-delivery", payload);
  return { ...payload, triggerDeliveryId: deliveryIdentity.id, triggerDeliveryHash: deliveryIdentity.hash };
}

function validBinding(binding, label) {
  assertFields(binding, ["worldModelId", "sourceSnapshotId", "graphSnapshotId"], label);
  if (!/^world-model-[a-f0-9]{24}$/.test(binding.worldModelId || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(binding.sourceSnapshotId || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(binding.graphSnapshotId || "")) {
    fail(`${label} is invalid.`, "INVALID_REFRESH_TRIGGER_DELIVERY");
  }
}

export function verifyRefreshTriggerDelivery(delivery, expectedOwner = null) {
  const format = familyFormatForOriginal("head-agent-core-refresh-trigger", delivery, expectedOwner);
  assertFields(delivery, ["schemaVersion", "kind", "protocol", "projectId", "triggerBatchId", "triggerBatchHash", "sourceKind", "status", "base", "next", "incrementalRefresh", "serialization", "projectionDisposition", "authority", "instructionAuthority", "promotionAuthority", "canonMutation", "triggerDeliveryId", "triggerDeliveryHash"], "Refresh trigger delivery");
  assertFields(delivery.incrementalRefresh, ["refreshRequestId", "refreshReceiptId"], "Refresh trigger delivery incremental refresh");
  assertFields(delivery.projectionDisposition, ["graph", "documents"], "Refresh trigger delivery projection disposition");
  const protocolVersion = delivery.protocol?.version;
  const legacy = protocolVersion === LEGACY_REFRESH_TRIGGER_VERSION;
  if (!legacy) assertFields(delivery.projectionDisposition.documents, ["status", "postRefreshProjectionReceiptId", "policyId"], "Refresh trigger delivery document projection disposition");
  validBinding(delivery.base, "Refresh trigger delivery base");
  validBinding(delivery.next, "Refresh trigger delivery next");
  if (delivery.schemaVersion !== SCHEMA_VERSION || delivery.kind !== "RefreshTriggerDeliveryReceipt"
    || !format
    || ![LEGACY_REFRESH_TRIGGER_VERSION, REFRESH_TRIGGER_VERSION].includes(protocolVersion)
    || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(delivery.projectId || "") || !BATCH_PATTERN.test(delivery.triggerBatchId || "")
    || !DELIVERY_PATTERN.test(delivery.triggerDeliveryId || "") || !SOURCE_KINDS.has(delivery.sourceKind)
    || !["ignored", "unchanged", "refreshed"].includes(delivery.status)
    || delivery.serialization !== "exclusive-project-world-model-writer-lease-and-expected-pointer-check"
    || (legacy && delivery.projectionDisposition.documents !== "not-regenerated-explicit-follow-up-only")
    || delivery.authority !== "verified-refresh-trigger-delivery-evidence" || delivery.instructionAuthority !== false
    || delivery.promotionAuthority !== false || delivery.canonMutation !== "none") {
    fail("Refresh trigger delivery contract is invalid.", "INVALID_REFRESH_TRIGGER_DELIVERY");
  }
  if (delivery.status === "ignored") {
    if (delivery.incrementalRefresh.refreshRequestId !== null || delivery.incrementalRefresh.refreshReceiptId !== null
      || canonicalJson(delivery.base) !== canonicalJson(delivery.next) || delivery.projectionDisposition.graph !== "unchanged") {
      fail("Ignored refresh trigger delivery is inconsistent.", "INVALID_REFRESH_TRIGGER_DELIVERY");
    }
  } else if (!/^incremental-refresh-request-[a-f0-9]{24}$/.test(delivery.incrementalRefresh.refreshRequestId || "")
    || !/^incremental-refresh-receipt-[a-f0-9]{24}$/.test(delivery.incrementalRefresh.refreshReceiptId || "")
    || delivery.projectionDisposition.graph !== "verified-by-incremental-refresh") {
    fail("Applied refresh trigger delivery is missing incremental refresh evidence.", "INVALID_REFRESH_TRIGGER_DELIVERY");
  }
  if (!legacy) {
    const documents = delivery.projectionDisposition.documents;
    const allowedStatuses = new Set(["not-evaluated-no-refresh", "manual-deferred", "projected", "unchanged", "blocked-edited-view", "blocked-stale-edited-view", "blocked-unmanaged-view", "failed"]);
    if (!allowedStatuses.has(documents.status)
      || (delivery.status === "ignored" && (documents.status !== "not-evaluated-no-refresh" || documents.postRefreshProjectionReceiptId !== null || documents.policyId !== null))
      || (delivery.status !== "ignored" && (!/^post-refresh-projection-receipt-[a-f0-9]{24}$/.test(documents.postRefreshProjectionReceiptId || "")
        || (documents.policyId !== null && !/^post-refresh-projection-policy-[a-f0-9]{24}$/.test(documents.policyId || ""))))) {
      fail("Refresh trigger document projection disposition is invalid.", "INVALID_REFRESH_TRIGGER_DELIVERY");
    }
  }
  const payload = { ...delivery };
  delete payload.triggerDeliveryId;
  delete payload.triggerDeliveryHash;
  const hash = digest(canonicalJson(payload));
  if (delivery.triggerDeliveryHash !== hash || delivery.triggerDeliveryId !== `refresh-trigger-delivery-${hash.slice(0, 24)}`) {
    fail("Refresh trigger delivery identity verification failed.", "REFRESH_TRIGGER_DELIVERY_DIGEST_MISMATCH");
  }
  return delivery;
}

function triggerRoot(projectRoot, storage = null) {
  return path.join(projectRoot, formatForVerifiedOwner(storage).directory, "refresh", "triggers");
}

function batchFile(projectRoot, batchId, storage = null) {
  if (!BATCH_PATTERN.test(batchId || "")) fail("Refresh trigger batch id is invalid.", "INVALID_REFRESH_TRIGGER_BATCH_ID");
  return path.join(triggerRoot(projectRoot, storage), "batches", `${batchId}.json`);
}

function deliveryFile(projectRoot, deliveryId, storage = null) {
  if (!DELIVERY_PATTERN.test(deliveryId || "")) fail("Refresh trigger delivery id is invalid.", "INVALID_REFRESH_TRIGGER_DELIVERY_ID");
  return path.join(triggerRoot(projectRoot, storage), "deliveries", `${deliveryId}.json`);
}

function currentFile(projectRoot, storage = null) {
  return path.join(triggerRoot(projectRoot, storage), "current.json");
}

function persistImmutable(file, document, verifier, label) {
  if (fs.existsSync(file)) {
    const stored = verifier(readJson(file, label));
    if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} conflicts with an existing immutable artifact.`, "REFRESH_TRIGGER_ARTIFACT_CONFLICT");
    return { file, created: false };
  }
  atomicWrite(file, json(document));
  const stored = verifier(readJson(file, label));
  if (canonicalJson(stored) !== canonicalJson(document)) fail(`${label} changed during persistence.`, "REFRESH_TRIGGER_ARTIFACT_WRITE_MISMATCH");
  return { file, created: true };
}

function buildPointer(delivery) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "RefreshTriggerPointer",
    projectId: delivery.projectId,
    triggerBatchId: delivery.triggerBatchId,
    triggerDeliveryId: delivery.triggerDeliveryId,
    worldModelId: delivery.next.worldModelId,
    sourceSnapshotId: delivery.next.sourceSnapshotId,
  };
  const pointerIdentity = identity("refresh-trigger-pointer", payload);
  return { ...payload, triggerPointerId: pointerIdentity.id, triggerPointerHash: pointerIdentity.hash };
}

function verifyPointer(pointer, storage = null) {
  const format = formatForVerifiedOwner(storage);
  assertFields(pointer, ["schemaVersion", "kind", "projectId", "triggerBatchId", "triggerDeliveryId", "worldModelId", "sourceSnapshotId", "triggerPointerId", "triggerPointerHash"], "Refresh trigger pointer");
  if (pointer.schemaVersion !== SCHEMA_VERSION || pointer.kind !== "RefreshTriggerPointer"
    || !new RegExp(`^${format.projectPrefix}[a-f0-9]{20}$`).test(pointer.projectId || "") || !BATCH_PATTERN.test(pointer.triggerBatchId || "")
    || !DELIVERY_PATTERN.test(pointer.triggerDeliveryId || "") || !/^world-model-[a-f0-9]{24}$/.test(pointer.worldModelId || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(pointer.sourceSnapshotId || "")) fail("Refresh trigger pointer is invalid.", "INVALID_REFRESH_TRIGGER_POINTER");
  const payload = { ...pointer };
  delete payload.triggerPointerId;
  delete payload.triggerPointerHash;
  const hash = digest(canonicalJson(payload));
  if (pointer.triggerPointerHash !== hash || pointer.triggerPointerId !== `refresh-trigger-pointer-${hash.slice(0, 24)}`) {
    fail("Refresh trigger pointer identity verification failed.", "REFRESH_TRIGGER_POINTER_DIGEST_MISMATCH");
  }
  return pointer;
}

export function readRefreshTriggerBatch({ root = ".", triggerBatchId } = {}) {
  const inspected = readyProject(root);
  const file = batchFile(inspected.project.projectRoot, triggerBatchId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Refresh trigger batch is missing: ${triggerBatchId}`, "REFRESH_TRIGGER_BATCH_NOT_FOUND");
  const batch = verifyRefreshTriggerBatch(readJson(file, "Refresh trigger batch"), inspected.storage);
  if (batch.projectId !== inspected.project.projectId) fail("Refresh trigger batch belongs to another project.", "REFRESH_TRIGGER_PROJECT_MISMATCH");
  return { status: "verified", file, batch };
}

export async function readRefreshTriggerDelivery({ root = ".", triggerDeliveryId, storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const inspected = readyProject(root);
  const file = deliveryFile(inspected.project.projectRoot, triggerDeliveryId, inspected.storage);
  if (!fs.existsSync(file)) fail(`Refresh trigger delivery is missing: ${triggerDeliveryId}`, "REFRESH_TRIGGER_DELIVERY_NOT_FOUND");
  const delivery = verifyRefreshTriggerDelivery(readJson(file, "Refresh trigger delivery"), inspected.storage);
  if (delivery.projectId !== inspected.project.projectId) fail("Refresh trigger delivery belongs to another project.", "REFRESH_TRIGGER_PROJECT_MISMATCH");
  const batchEntry = readRefreshTriggerBatch({ root: inspected.project.projectRoot, triggerBatchId: delivery.triggerBatchId });
  if (batchEntry.batch.triggerBatchHash !== delivery.triggerBatchHash || batchEntry.batch.source.kind !== delivery.sourceKind) {
    fail("Refresh trigger batch and delivery disagree.", "REFRESH_TRIGGER_BATCH_DELIVERY_MISMATCH");
  }
  if (batchEntry.batch.requiresRescan !== (delivery.status !== "ignored")) {
    fail("Refresh trigger batch rescan disposition does not match its delivery.", "REFRESH_TRIGGER_BATCH_DELIVERY_MISMATCH");
  }
  let refreshEntry = null;
  let postRefreshProjection = null;
  if (delivery.status !== "ignored") {
    refreshEntry = (await readIncrementalRefreshReceipt({
      root: inspected.project.projectRoot,
      refreshReceiptId: delivery.incrementalRefresh.refreshReceiptId,
      storeAdapter,
    }));
    if (refreshEntry.receipt.refreshRequestId !== delivery.incrementalRefresh.refreshRequestId
      || refreshEntry.request.trigger.kind !== delivery.sourceKind
      || canonicalJson(refreshEntry.request.trigger.evidenceIds) !== canonicalJson([delivery.triggerBatchId])
      || refreshEntry.receipt.status !== delivery.status
      || canonicalJson(refreshEntry.receipt.base) !== canonicalJson(delivery.base)
      || canonicalJson(refreshEntry.receipt.next.worldModelId) !== canonicalJson(delivery.next.worldModelId)
      || refreshEntry.receipt.next.sourceSnapshotId !== delivery.next.sourceSnapshotId
      || refreshEntry.receipt.next.graphSnapshotId !== delivery.next.graphSnapshotId) {
      fail("Refresh trigger delivery does not match its incremental refresh receipt.", "REFRESH_TRIGGER_DELIVERY_REFRESH_MISMATCH");
    }
    if (delivery.protocol.version === REFRESH_TRIGGER_VERSION) {
      postRefreshProjection = (await readPostRefreshProjectionReceipt({
        root: inspected.project.projectRoot,
        postRefreshProjectionReceiptId: delivery.projectionDisposition.documents.postRefreshProjectionReceiptId,
        storeAdapter,
        documentProjectionAdapter,
      }));
      if (postRefreshProjection.receipt.refresh.refreshRequestId !== refreshEntry.request.refreshRequestId
        || postRefreshProjection.receipt.refresh.refreshReceiptId !== refreshEntry.receipt.refreshReceiptId
        || postRefreshProjection.receipt.outcome.status !== delivery.projectionDisposition.documents.status
        || (postRefreshProjection.receipt.policy?.policyId || null) !== delivery.projectionDisposition.documents.policyId) {
        fail("Refresh trigger delivery does not match its post-refresh projection receipt.", "REFRESH_TRIGGER_DELIVERY_DOCUMENT_PROJECTION_MISMATCH");
      }
    }
  } else {
    const snapshot = (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId: delivery.base.worldModelId, storeAdapter })).snapshot;
    if (canonicalJson(snapshotBinding(snapshot)) !== canonicalJson(delivery.base)) fail("Ignored refresh trigger delivery snapshot is missing or inconsistent.", "REFRESH_TRIGGER_DELIVERY_SNAPSHOT_MISMATCH");
  }
  return { status: "verified", file, delivery, batchFile: batchEntry.file, batch: batchEntry.batch, refresh: refreshEntry, postRefreshProjection };
}

export async function inspectRefreshTriggers({ root = ".", storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const inspected = readyProject(root);
  const file = currentFile(inspected.project.projectRoot, inspected.storage);
  const world = (await readWorldModel({ root: inspected.project.projectRoot, storeAdapter }));
  const writer = inspectRefreshWriterLease({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  if (!fs.existsSync(file)) return {
    status: "not-triggered",
    currentWorldModelId: world.snapshot.worldModelId,
    currentSourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    writer,
  };
  const pointer = verifyPointer(readJson(file, "Refresh trigger pointer"), inspected.storage);
  if (pointer.projectId !== inspected.project.projectId) fail("Refresh trigger pointer belongs to another project.", "REFRESH_TRIGGER_PROJECT_MISMATCH");
  const deliveryEntry = (await readRefreshTriggerDelivery({ root: inspected.project.projectRoot, triggerDeliveryId: pointer.triggerDeliveryId, storeAdapter, documentProjectionAdapter }));
  if (deliveryEntry.delivery.triggerBatchId !== pointer.triggerBatchId || deliveryEntry.delivery.next.worldModelId !== pointer.worldModelId
    || deliveryEntry.delivery.next.sourceSnapshotId !== pointer.sourceSnapshotId) fail("Refresh trigger pointer and delivery disagree.", "REFRESH_TRIGGER_POINTER_MISMATCH");
  const freshness = (await inspectWorldModel({ root: inspected.project.projectRoot, storeAdapter }));
  return {
    status: world.snapshot.worldModelId === pointer.worldModelId && freshness.status === "current" ? "current" : "stale",
    pointerFile: file,
    pointer,
    delivery: deliveryEntry.delivery,
    batch: deliveryEntry.batch,
    currentWorldModelId: world.snapshot.worldModelId,
    currentSourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    worldModelFreshness: freshness.status,
    writer,
  };
}

async function processRefreshTriggerBatchInternal({
  root = ".",
  sourceKind,
  events = [],
  maxEvents = DEFAULT_REFRESH_EVENT_LIMIT,
  overflowEventCount = 0,
  overflowRescanRequired = false,
  storeAdapter = null,
  graphProjectionAdapter = null,
  documentProjectionAdapter = null,
  gitHistoryAdapter = null,
  runtimeStateAdapter = null,
} = {}) {
  const inspected = readyProject(root);
  const projectRoot = inspected.project.projectRoot;
  const batch = buildRefreshTriggerBatch({
    projectId: inspected.project.projectId,
    sourceKind,
    events,
    managedRootFiles: managedRootFilesForProject(inspected.project, inspected.storage),
    maxEvents,
    overflowEventCount,
    overflowRescanRequired,
  }, inspected.storage);
  const batchEntry = persistImmutable(batchFile(projectRoot, batch.triggerBatchId, inspected.storage), batch, (record) => verifyRefreshTriggerBatch(record, inspected.storage), "Refresh trigger batch");
  return (await withRefreshWriterLease({ projectRoot, projectId: inspected.project.projectId, storage: inspected.storage }, async (writerLease) => {
    const before = (await readWorldModel({ root: projectRoot, storeAdapter })).snapshot;
    let refresh = null;
    if (batch.requiresRescan) {
      refresh = await refreshWorldModel({
        root: projectRoot,
        triggerKind: batch.source.kind,
        triggerEvidenceIds: [batch.triggerBatchId],
        storeAdapter,
        graphProjectionAdapter,
        documentProjectionAdapter,
        gitHistoryAdapter,
        runtimeStateAdapter,
        writerLease,
      });
    }
    const after = refresh ? (await readWorldModel({ root: projectRoot, storeAdapter })).snapshot : before;
    const delivery = buildDelivery({
      batch,
      status: refresh?.status || "ignored",
      base: refresh ? refresh.receipt.base : snapshotBinding(before),
      next: refresh ? {
        worldModelId: refresh.receipt.next.worldModelId,
        sourceSnapshotId: refresh.receipt.next.sourceSnapshotId,
        graphSnapshotId: refresh.receipt.next.graphSnapshotId,
      } : snapshotBinding(after),
      refreshRequestId: refresh?.request.refreshRequestId || null,
      refreshReceiptId: refresh?.receipt.refreshReceiptId || null,
      postRefreshProjection: refresh?.postRefreshProjection || null,
    });
    const deliveryEntry = persistImmutable(deliveryFile(projectRoot, delivery.triggerDeliveryId, inspected.storage), delivery, (record) => verifyRefreshTriggerDelivery(record, inspected.storage), "Refresh trigger delivery");
    const pointer = buildPointer(delivery);
    atomicWrite(currentFile(projectRoot, inspected.storage), json(pointer));
    const storedPointer = verifyPointer(readJson(currentFile(projectRoot, inspected.storage), "Refresh trigger pointer"), inspected.storage);
    if (canonicalJson(storedPointer) !== canonicalJson(pointer)) fail("Refresh trigger pointer changed during persistence.", "REFRESH_TRIGGER_POINTER_WRITE_MISMATCH");
    return {
      status: delivery.status,
      batchFile: batchEntry.file,
      deliveryFile: deliveryEntry.file,
      pointerFile: currentFile(projectRoot, inspected.storage),
      batch,
      delivery,
      pointer,
      refresh,
    };
  }));
}

export async function processRefreshTriggerBatch(options = {}) {
  assertFields(options, ["root", "sourceKind", "events", "maxEvents", "overflowEventCount", "overflowRescanRequired", "storeAdapter", "graphProjectionAdapter", "documentProjectionAdapter", "gitHistoryAdapter", "runtimeStateAdapter"], "Refresh trigger ingestion options");
  return (await processRefreshTriggerBatchInternal(options));
}

export class DebouncedRefreshTriggerQueue {
  constructor({
    root = ".",
    sourceKind,
    debounceMs = DEFAULT_REFRESH_DEBOUNCE_MS,
    maxEvents = DEFAULT_REFRESH_EVENT_LIMIT,
    deliverBatch = processRefreshTriggerBatch,
    documentProjectionAdapter = null,
    onDelivery = () => {},
    onError = () => {},
  } = {}) {
    const inspected = readyProject(root);
    if (!Number.isInteger(debounceMs) || debounceMs < 25 || debounceMs > 60000) fail("Refresh debounce must be an integer from 25 through 60000 milliseconds.", "INVALID_REFRESH_DEBOUNCE");
    if (typeof deliverBatch !== "function" || typeof onDelivery !== "function" || typeof onError !== "function") fail("Refresh queue callbacks are invalid.", "INVALID_REFRESH_TRIGGER_QUEUE");
    this.root = inspected.project.projectRoot;
    this.projectId = inspected.project.projectId;
    this.storage = inspected.storage;
    this.managedRootFiles = managedRootFilesForProject(inspected.project, inspected.storage);
    this.sourceKind = normalizedSourceKind(sourceKind);
    this.debounceMs = debounceMs;
    this.maxEvents = normalizedEventLimit(maxEvents);
    this.deliverBatch = deliverBatch;
    this.documentProjectionAdapter = documentProjectionAdapter;
    this.onDelivery = onDelivery;
    this.onError = onError;
    this.buffer = [];
    this.overflowEventCount = 0;
    this.overflowRescanRequired = false;
    this.timer = null;
    this.tail = Promise.resolve();
    this.closed = false;
    this.totalInputEvents = 0;
    this.totalDeliveredBatches = 0;
    this.totalBusyRetries = 0;
    this.consecutiveBusyRetries = 0;
  }

  schedule(delay = this.debounceMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => {
        try { this.onError(error); } catch {}
      });
    }, delay);
    this.timer.unref?.();
  }

  enqueue(event) {
    if (this.closed) fail("Refresh trigger queue is closed.", "REFRESH_TRIGGER_QUEUE_CLOSED");
    const normalized = normalizeTriggerEvent(event, 0, this.managedRootFiles, this.storage);
    const affectsProject = !normalized.ignored;
    this.totalInputEvents += 1;
    if (this.buffer.length < this.maxEvents) this.buffer.push(event);
    else {
      this.overflowEventCount += 1;
      this.overflowRescanRequired ||= affectsProject;
    }
    if (affectsProject) {
      this.schedule();
    }
    return { acceptedForDebounce: affectsProject, bufferedEventCount: this.buffer.length, overflowEventCount: this.overflowEventCount };
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const hasRescanSignal = this.buffer.some((event, index) => !normalizeTriggerEvent(event, index, this.managedRootFiles, this.storage).ignored) || this.overflowRescanRequired;
    if (!hasRescanSignal) return Promise.resolve(null);
    const events = this.buffer;
    const overflowEventCount = this.overflowEventCount;
    const overflowRescanRequired = this.overflowRescanRequired;
    this.buffer = [];
    this.overflowEventCount = 0;
    this.overflowRescanRequired = false;
    const delivery = this.tail.catch(() => {}).then(() => this.deliverBatch({
      root: this.root,
      sourceKind: this.sourceKind,
      events,
      maxEvents: this.maxEvents,
      overflowEventCount,
      overflowRescanRequired,
      documentProjectionAdapter: this.documentProjectionAdapter,
    }));
    const operation = delivery.then((result) => {
      this.consecutiveBusyRetries = 0;
      return result;
    }, (error) => {
      if (error?.code === "REFRESH_WRITER_BUSY" && !this.closed) {
        const combined = [...events, ...this.buffer];
        const retained = combined.slice(0, this.maxEvents);
        const newlyOverflowed = Math.max(0, combined.length - retained.length);
        this.buffer = retained;
        this.overflowEventCount += overflowEventCount + newlyOverflowed;
        this.overflowRescanRequired = true;
        this.totalBusyRetries += 1;
        this.consecutiveBusyRetries += 1;
        this.schedule(Math.max(this.debounceMs, 1000));
      }
      throw error;
    });
    this.tail = operation;
    operation.then((result) => {
      this.totalDeliveredBatches += 1;
      try { this.onDelivery(result); }
      catch (error) {
        try { this.onError(error); } catch {}
      }
    }, () => {});
    return operation;
  }

  async close({ flush = true } = {}) {
    if (this.closed) return this.status();
    try {
      if (flush) await this.flush();
      await this.tail;
    } finally {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.closed = true;
      this.buffer = [];
      this.overflowEventCount = 0;
      this.overflowRescanRequired = false;
    }
    return this.status();
  }

  status() {
    return {
      sourceKind: this.sourceKind,
      debounceMs: this.debounceMs,
      maxEvents: this.maxEvents,
      bufferedEventCount: this.buffer.length,
      overflowEventCount: this.overflowEventCount,
      totalInputEvents: this.totalInputEvents,
      totalDeliveredBatches: this.totalDeliveredBatches,
      totalBusyRetries: this.totalBusyRetries,
      consecutiveBusyRetries: this.consecutiveBusyRetries,
      closed: this.closed,
      authority: "operational-event-coalescing-only",
    };
  }
}

export function createFileSystemRefreshWatcher({
  root = ".",
  debounceMs = DEFAULT_REFRESH_DEBOUNCE_MS,
  maxEvents = DEFAULT_REFRESH_EVENT_LIMIT,
  documentProjectionAdapter = null,
  onDelivery = () => {},
  onError = () => {},
} = {}) {
  const queue = new DebouncedRefreshTriggerQueue({ root, sourceKind: "filesystem", debounceMs, maxEvents, documentProjectionAdapter, onDelivery, onError });
  const reportError = (error) => {
    try { onError(error); } catch {}
  };
  let watcher;
  try {
    watcher = fs.watch(queue.root, { recursive: true, encoding: "utf8" }, async (eventType, filename) => {
      try {
        (await queue.enqueue(filename == null
          ? { kind: "project-signal", operation: "unknown", path: null, evidenceId: null }
          : { kind: "path-hint", operation: eventType === "rename" ? "rename" : "change", path: String(filename), evidenceId: null }));
      } catch (error) {
        reportError(error);
      }
    });
  } catch (error) {
    fail(`Filesystem refresh watcher could not start: ${error.message}`, "REFRESH_WATCHER_START_FAILED");
  }
  watcher.on("error", reportError);
  return {
    projectRoot: queue.root,
    queue,
    watcher,
    async close({ flush = true } = {}) {
      watcher.close();
      return queue.close({ flush });
    },
    status() { return queue.status(); },
  };
}

export async function runFileSystemRefreshWatcher(options = {}) {
  const deliveries = [];
  const errors = [];
  let deliveryCount = 0;
  let errorCount = 0;
  let finishWatcher = null;
  const recordBounded = (collection, value) => {
    if (collection.length === 100) collection.shift();
    collection.push(value);
  };
  const handle = createFileSystemRefreshWatcher({
    ...options,
    onDelivery: (result) => {
      deliveryCount += 1;
      recordBounded(deliveries, {
        triggerBatchId: result.batch.triggerBatchId,
        triggerDeliveryId: result.delivery.triggerDeliveryId,
        status: result.status,
      });
    },
    onError: (error) => {
      errorCount += 1;
      recordBounded(errors, { code: error.code || "REFRESH_WATCHER_ERROR", message: error.message });
      if (finishWatcher) void finishWatcher("WATCHER_ERROR");
    },
  });
  return new Promise((resolve, reject) => {
    let closing = false;
    const finish = async (signal) => {
      if (closing) return;
      closing = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      try {
        const queue = await handle.close({ flush: true });
        resolve({
          status: errorCount ? "stopped-with-errors" : "stopped",
          signal,
          queue,
          deliveryCount,
          retainedDeliveryCount: deliveries.length,
          deliveries,
          errorCount,
          retainedErrorCount: errors.length,
          errors,
        });
      } catch (error) {
        reject(error);
      }
    };
    const onSigint = async () => { void (await finish("SIGINT")); };
    const onSigterm = async () => { void (await finish("SIGTERM")); };
    finishWatcher = finish;
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}
