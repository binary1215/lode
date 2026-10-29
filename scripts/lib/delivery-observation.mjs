import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import {
  createObservationTypeDescriptor,
  observationCanonicalJson,
  observationDigest,
  stableKey,
} from "./observation-contract.mjs";
import {
  assertObservationProjectReady,
  loadObservationArtifacts,
  recordDeliveryCollectedObservation,
} from "./observation-store.mjs";
import { buildWorldModel, readWorldModelSnapshot } from "./world-model.mjs";

export const DELIVERY_OBSERVATION_VERSION = "0.1.0";
export const DELIVERY_OBSERVATION_TYPE_KEY = "delivery.state";

const OUTCOMES = new Set(["applied", "failed", "cancelled", "rolled-back"]);
const fail = (message, code = "DELIVERY_OBSERVATION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function requiredText(value, label, max = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > max) fail(`${label} is invalid.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
  return normalized;
}

function digestValue(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(`${label} must be a SHA-256 digest.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
  return normalized;
}

function observationId(value, label, optional = true) {
  if (value == null || value === "") {
    if (optional) return null;
    fail(`${label} is required.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
  }
  const normalized = String(value).trim();
  if (!/^observation-[a-f0-9]{24}$/.test(normalized)) fail(`${label} is invalid.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
  return normalized;
}

function timestamp(value, label) {
  const normalized = requiredText(value, label, 64);
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date-time.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
  return new Date(normalized).toISOString();
}

function exactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Delivery observation input must be an object.", "INVALID_DELIVERY_OBSERVATION_INPUT");
  const allowed = new Set([
    "environmentKey", "targetKey", "artifactKey", "revisionKey", "revisionDigest", "outcome", "sequence",
    "predecessorObservationId", "rollbackTargetObservationId", "observedAt", "sourceScopeDigest",
    "sourceEventKeyDigest", "sourceEvidenceDigest", "adapterKey", "adapterVersion", "revisionReference",
  ]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`Delivery observation input has unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_DELIVERY_OBSERVATION_INPUT");
}

export function deliveryObservationDescriptor(storage = null) {
  return createObservationTypeDescriptor({
    typeKey: DELIVERY_OBSERVATION_TYPE_KEY,
    typeVersion: "1",
    forms: ["event"],
    payloadSchema: {
      fields: [
        { key: "environment_key", type: "stable-key", required: true },
        { key: "target_key", type: "stable-key", required: true },
        { key: "artifact_key", type: "stable-key", required: true },
        { key: "revision_key", type: "stable-key", required: true },
        { key: "revision_digest", type: "sha256", required: true },
        { key: "outcome", type: "enum", required: true, enum: [...OUTCOMES] },
        { key: "sequence", type: "nonnegative-integer", required: true },
        { key: "predecessor_observation_id", type: "string", required: false, max: 96 },
        { key: "rollback_target_observation_id", type: "string", required: false, max: 96 },
        { key: "revision_binding", type: "enum", required: true, enum: ["declared", "verified-source-revision"] },
        { key: "bound_world_model_id", type: "string", required: false, max: 96 },
        { key: "bound_revision_id", type: "string", required: false, max: 96 },
        { key: "bound_logical_entity_id", type: "string", required: false, max: 96 },
        { key: "bound_source_path", type: "string", required: false, max: 4096 },
      ],
      additionalFields: false,
    },
  }, storage);
}

async function normalizeRevisionReference(root, value, revisionDigest) {
  if (value == null) return { revision_binding: "declared" };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("revisionReference must be an object.", "INVALID_DELIVERY_REVISION_REFERENCE");
  const expected = ["worldModelId", "revisionId", "sourcePath", "digest"].sort();
  if (observationCanonicalJson(Object.keys(value).sort()) !== observationCanonicalJson(expected)) fail("revisionReference fields are invalid.", "INVALID_DELIVERY_REVISION_REFERENCE");
  const worldModelId = requiredText(value.worldModelId, "revisionReference.worldModelId", 96);
  const revisionId = requiredText(value.revisionId, "revisionReference.revisionId", 96);
  const sourcePath = requiredText(value.sourcePath, "revisionReference.sourcePath", 4096).replaceAll("\\", "/");
  const digest = digestValue(value.digest, "revisionReference.digest");
  if (digest !== revisionDigest) fail("Declared revision digest does not match the exact source revision reference.", "DELIVERY_REVISION_REFERENCE_INVALID");
  const snapshot = (await readWorldModelSnapshot({ root, worldModelId })).snapshot;
  const revision = snapshot.temporalProvenanceGraph?.nodes.find((node) => node.nodeId === revisionId);
  if (!revision || revision.kind !== "FileRevision" || revision.path !== sourcePath || revision.digest !== digest) {
    fail("Exact source revision reference is absent from the verified World Model snapshot.", "DELIVERY_REVISION_REFERENCE_INVALID");
  }
  return {
    revision_binding: "verified-source-revision",
    bound_world_model_id: worldModelId,
    bound_revision_id: revision.nodeId,
    bound_logical_entity_id: revision.logicalEntityId,
    bound_source_path: revision.path,
  };
}

function existingReplay(artifacts, adapterKey, adapterVersion, sourceScopeDigest, sourceEventKeyDigest) {
  return artifacts.observations.find((record) => record.source.adapterKey === adapterKey
    && record.source.adapterVersion === adapterVersion
    && record.source.sourceScopeDigest === sourceScopeDigest
    && record.source.sourceEventKeyDigest === sourceEventKeyDigest) || null;
}

export async function recordDeliveryObservation({ root = ".", ...input } = {}) {
  exactInput(input);
  const inspected = assertObservationProjectReady(root);
  const environmentKey = stableKey(input.environmentKey, "Delivery environment key", 128);
  const targetKey = stableKey(input.targetKey, "Delivery target key", 128);
  const artifactKey = stableKey(input.artifactKey, "Delivery artifact key", 192);
  const revisionKey = stableKey(input.revisionKey, "Delivery revision key", 192);
  const revisionDigest = digestValue(input.revisionDigest, "Delivery revision digest");
  const outcome = requiredText(input.outcome, "Delivery outcome", 32).toLowerCase();
  if (!OUTCOMES.has(outcome)) fail("Delivery outcome must be applied, failed, cancelled, or rolled-back.", "INVALID_DELIVERY_OBSERVATION_INPUT");
  const sequence = Number(input.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("Delivery sequence must be a nonnegative safe integer.", "INVALID_DELIVERY_OBSERVATION_INPUT");
  const predecessorObservationId = observationId(input.predecessorObservationId, "Delivery predecessor observation id");
  const rollbackTargetObservationId = observationId(input.rollbackTargetObservationId, "Delivery rollback target observation id");
  if (outcome === "rolled-back" && !rollbackTargetObservationId) fail("Rolled-back delivery observations require an exact rollback target.", "INVALID_DELIVERY_OBSERVATION_INPUT");
  if (outcome !== "rolled-back" && rollbackTargetObservationId) fail("Only rolled-back delivery observations may name a rollback target.", "INVALID_DELIVERY_OBSERVATION_INPUT");
  const adapterKey = stableKey(input.adapterKey || formatForVerifiedOwner(inspected.storage).value("head.delivery-host-input"), "Delivery adapter key", 192);
  const adapterVersion = stableKey(input.adapterVersion || DELIVERY_OBSERVATION_VERSION, "Delivery adapter version", 64);
  const sourceScopeDigest = digestValue(input.sourceScopeDigest, "Delivery source scope digest");
  const sourceEventKeyDigest = digestValue(input.sourceEventKeyDigest, "Delivery source event key digest");
  const sourceEvidenceDigest = digestValue(input.sourceEvidenceDigest, "Delivery source evidence digest");
  const artifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const replay = existingReplay(artifacts, adapterKey, adapterVersion, sourceScopeDigest, sourceEventKeyDigest);
  const observedAt = input.observedAt == null
    ? replay?.temporalScope.observedAt || new Date().toISOString()
    : timestamp(input.observedAt, "Delivery observedAt");
  const revisionReference = (await normalizeRevisionReference(inspected.project.projectRoot, input.revisionReference, revisionDigest));
  const payload = {
    environment_key: environmentKey,
    target_key: targetKey,
    artifact_key: artifactKey,
    revision_key: revisionKey,
    revision_digest: revisionDigest,
    outcome,
    sequence,
    ...(predecessorObservationId ? { predecessor_observation_id: predecessorObservationId } : {}),
    ...(rollbackTargetObservationId ? { rollback_target_observation_id: rollbackTargetObservationId } : {}),
    ...revisionReference,
  };
  const descriptor = deliveryObservationDescriptor(inspected.storage);
  const recorded = await recordDeliveryCollectedObservation({
    root: inspected.project.projectRoot,
    descriptor,
    input: {
      subject: {
        type: "delivery-target",
        key: `delivery.${observationDigest({ environmentKey, targetKey }).slice(0, 24)}`,
      },
      form: "event",
      temporalScope: { observedAt, start: null, end: null },
      coverage: {
        state: "partial",
        basis: "single-host-reported-delivery-event",
        queryDigest: null,
        examinedCount: 1,
        sourceReportedTotal: null,
        omittedCount: null,
        cursorStartDigest: null,
        cursorEndDigest: null,
      },
      sourceEventKeyDigest,
      sourceEvidenceDigest,
      payload,
    },
    adapterDescriptor: {
      adapterKey,
      adapterVersion,
      authority: "host-delivery-observation-evidence-only",
      providerNeutral: true,
      persistsProviderIdentity: false,
    },
    sourceScopeDigest,
  });
  const world = await buildWorldModel({ root: inspected.project.projectRoot, persist: true });
  return {
    ...recorded,
    worldModel: {
      worldModelId: world.snapshot.worldModelId,
      graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId,
    },
    authority: {
      observation: "P3-evidence-only",
      currentState: "P4-derived-nonpersisted",
      productCanonMutated: false,
      reviewDecisionCreated: false,
      recoveryDirectionMutated: false,
    },
    ordinaryWorkBlocked: false,
  };
}

async function retainedWorldSnapshot(root, worldModelId, cache) {
  if (!cache.has(worldModelId)) {
    try { cache.set(worldModelId, { snapshot: (await readWorldModelSnapshot({ root, worldModelId })).snapshot, errorCode: null }); }
    catch (error) { cache.set(worldModelId, { snapshot: null, errorCode: String(error?.code || "invalid").toLowerCase() }); }
  }
  const cached = cache.get(worldModelId);
  if (!cached.snapshot) throw Object.assign(new Error("retained World snapshot unavailable"), { code: cached.errorCode });
  return cached.snapshot;
}

async function revisionReferenceStatus(root, payload, snapshotCache) {
  const boundFields = ["bound_world_model_id", "bound_revision_id", "bound_logical_entity_id", "bound_source_path"];
  if (payload.revision_binding === "declared") {
    const invalid = boundFields.some((field) => Object.hasOwn(payload, field));
    return {
      binding: invalid ? "invalid" : "declared",
      exactRevisionReferenceEstablished: false,
      worldModelId: null,
      revisionId: null,
      logicalEntityId: null,
      sourcePath: null,
      ...(invalid ? { issue: "declared-binding-has-verified-fields" } : {}),
    };
  }
  if (payload.revision_binding !== "verified-source-revision"
    || boundFields.some((field) => typeof payload[field] !== "string" || !payload[field])) {
    return {
      binding: "invalid",
      exactRevisionReferenceEstablished: false,
      worldModelId: null,
      revisionId: null,
      logicalEntityId: null,
      sourcePath: null,
      issue: "verified-binding-fields-missing",
    };
  }
  try {
    const snapshot = (await retainedWorldSnapshot(root, payload.bound_world_model_id, snapshotCache));
    const revision = snapshot.temporalProvenanceGraph?.nodes.find((node) => node.nodeId === payload.bound_revision_id);
    if (!revision || revision.kind !== "FileRevision"
      || revision.logicalEntityId !== payload.bound_logical_entity_id
      || revision.path !== payload.bound_source_path
      || revision.digest !== payload.revision_digest) throw Object.assign(new Error("mismatch"), { code: "REVISION_MISMATCH" });
    return {
      binding: "verified-source-revision",
      exactRevisionReferenceEstablished: true,
      worldModelId: payload.bound_world_model_id,
      revisionId: payload.bound_revision_id,
      logicalEntityId: payload.bound_logical_entity_id,
      sourcePath: payload.bound_source_path,
    };
  } catch (error) {
    return {
      binding: "invalid",
      exactRevisionReferenceEstablished: false,
      worldModelId: null,
      revisionId: null,
      logicalEntityId: null,
      sourcePath: null,
      issue: `verified-binding-${String(error?.code || "invalid").toLowerCase()}`,
    };
  }
}

async function historyEntry(record, root, snapshotCache) {
  const payload = record.payload;
  return {
    observationId: record.observationId,
    observationHash: record.observationHash,
    observedAt: record.temporalScope.observedAt,
    sequence: payload.sequence,
    predecessorObservationId: payload.predecessor_observation_id || null,
    rollbackTargetObservationId: payload.rollback_target_observation_id || null,
    outcome: payload.outcome,
    artifactKey: payload.artifact_key,
    revisionKey: payload.revision_key,
    revisionDigest: payload.revision_digest,
    revisionReference: (await revisionReferenceStatus(root, payload, snapshotCache)),
  };
}

async function groupProjection(records, root, snapshotCache) {
  const byId = new Map(records.map((record) => [record.observationId, record]));
  const entriesById = new Map((await Promise.all(records.map(async (record) => [record.observationId, (await historyEntry(record, root, snapshotCache))]))));
  const issues = [];
  const issue = (code, observationId = null, relatedObservationId = null) => issues.push({ code, observationId, relatedObservationId });
  const sequenceOwners = new Map();
  const successorOwners = new Map();
  for (const record of records) {
    const revisionReference = entriesById.get(record.observationId).revisionReference;
    if (revisionReference.binding === "invalid") issue("invalid-revision-binding", record.observationId, revisionReference.issue || null);
    const sequence = record.payload.sequence;
    const owners = sequenceOwners.get(sequence) || [];
    owners.push(record.observationId);
    sequenceOwners.set(sequence, owners);
    const predecessorId = record.payload.predecessor_observation_id || null;
    if (sequence === 0 && predecessorId) issue("root-has-predecessor", record.observationId, predecessorId);
    if (sequence > 0 && !predecessorId) issue("missing-predecessor", record.observationId);
    if (predecessorId) {
      const successors = successorOwners.get(predecessorId) || [];
      successors.push(record.observationId);
      successorOwners.set(predecessorId, successors);
      const predecessor = byId.get(predecessorId);
      if (!predecessor) issue("predecessor-not-found-in-target-history", record.observationId, predecessorId);
      else if (predecessor.payload.sequence !== sequence - 1) issue("predecessor-sequence-mismatch", record.observationId, predecessorId);
    }
    const rollbackId = record.payload.rollback_target_observation_id || null;
    if (record.payload.outcome === "rolled-back") {
      const rollbackTarget = rollbackId ? byId.get(rollbackId) : null;
      if (!rollbackTarget) issue("rollback-target-not-found-in-target-history", record.observationId, rollbackId);
      else if (!new Set(["applied", "rolled-back"]).has(rollbackTarget.payload.outcome)) issue("rollback-target-was-not-applied", record.observationId, rollbackId);
    }
  }
  for (const [sequence, owners] of sequenceOwners) if (owners.length > 1) {
    for (const owner of owners) issue("duplicate-sequence", owner, String(sequence));
  }
  for (const [predecessorId, successors] of successorOwners) if (successors.length > 1) {
    for (const successor of successors) issue("divergent-successor", successor, predecessorId);
  }
  const roots = records.filter((record) => record.payload.sequence === 0 && !record.payload.predecessor_observation_id);
  if (records.length && roots.length !== 1) issue("non-unique-root", roots[0]?.observationId || null);
  const ordered = [...records].sort((left, right) => left.payload.sequence - right.payload.sequence || left.observationId.localeCompare(right.observationId));
  const uniqueIssues = [...new Map(issues.map((entry) => [observationCanonicalJson(entry), entry])).values()]
    .sort((left, right) => observationCanonicalJson(left).localeCompare(observationCanonicalJson(right)));
  let currentRecord = null;
  if (!uniqueIssues.length) {
    for (const record of ordered) if (new Set(["applied", "rolled-back"]).has(record.payload.outcome)) currentRecord = record;
  }
  const lastAttempt = uniqueIssues.length || !ordered.length ? null : entriesById.get(ordered.at(-1).observationId);
  return {
    state: uniqueIssues.length || !currentRecord ? "unknown" : "known",
    ordering: {
      basis: "explicit-sequence-and-predecessor-not-receipt-time",
      coherent: uniqueIssues.length === 0,
      issues: uniqueIssues,
    },
    current: currentRecord ? entriesById.get(currentRecord.observationId) : null,
    lastAttempt,
    orderedHistory: ordered.map((record) => entriesById.get(record.observationId)),
  };
}

function projectionIdentity(payload) {
  const projectionHash = observationDigest(payload);
  return { ...payload, projectionId: `delivery-state-projection-${projectionHash.slice(0, 24)}`, projectionHash };
}

export async function inspectDeliveryState({ root = ".", environmentKey = "", targetKey = "", historyLimit = 100 } = {}) {
  const inspected = assertObservationProjectReady(root);
  const normalizedEnvironment = environmentKey ? stableKey(environmentKey, "Delivery environment filter", 128) : "";
  const normalizedTarget = targetKey ? stableKey(targetKey, "Delivery target filter", 128) : "";
  const boundedHistoryLimit = Number(historyLimit);
  if (!Number.isInteger(boundedHistoryLimit) || boundedHistoryLimit < 1 || boundedHistoryLimit > 4096) fail("Delivery history limit must be between 1 and 4096.", "INVALID_DELIVERY_STATUS_INPUT");
  const descriptor = deliveryObservationDescriptor(inspected.storage);
  const artifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const records = artifacts.observations.filter((record) => record.descriptorId === descriptor.descriptorId
    && (!normalizedEnvironment || record.payload.environment_key === normalizedEnvironment)
    && (!normalizedTarget || record.payload.target_key === normalizedTarget));
  const grouped = new Map();
  const snapshotCache = new Map();
  for (const record of records) {
    const key = observationCanonicalJson([record.payload.environment_key, record.payload.target_key, record.payload.artifact_key]);
    const current = grouped.get(key) || [];
    current.push(record);
    grouped.set(key, current);
  }
  const completeTargets = (await Promise.all([...grouped.values()].map(async (items) => {
    const derived = (await groupProjection(items, inspected.project.projectRoot, snapshotCache));
    return {
      environmentKey: items[0].payload.environment_key,
      targetKey: items[0].payload.target_key,
      artifactKey: items[0].payload.artifact_key,
      state: derived.state,
      ordering: derived.ordering,
      current: derived.current,
      lastAttempt: derived.lastAttempt,
      history: derived.orderedHistory,
    };
  }))).sort((left, right) => left.environmentKey.localeCompare(right.environmentKey)
    || left.targetKey.localeCompare(right.targetKey)
    || left.artifactKey.localeCompare(right.artifactKey));
  const environmentKeys = [...new Set(completeTargets.map((target) => target.environmentKey))].sort();
  const environments = environmentKeys.map((key) => {
    const targets = completeTargets.filter((target) => target.environmentKey === key);
    const known = targets.filter((target) => target.state === "known");
    const artifactKeys = [...new Set(targets.map((target) => target.artifactKey))].sort();
    const artifacts = artifactKeys.map((artifactKey) => {
      const artifactTargets = targets.filter((target) => target.artifactKey === artifactKey);
      const knownArtifactTargets = artifactTargets.filter((target) => target.state === "known");
      const revisions = [...new Set(knownArtifactTargets.map((target) => `${target.current.revisionKey}:${target.current.revisionDigest}`))].sort();
      return {
        artifactKey,
        state: knownArtifactTargets.length !== artifactTargets.length ? "unknown" : revisions.length > 1 ? "mixed" : "uniform",
        observedTargetCount: new Set(artifactTargets.map((target) => target.targetKey)).size,
        knownTargetCount: new Set(knownArtifactTargets.map((target) => target.targetKey)).size,
        currentRevisionIdentities: revisions,
      };
    });
    const states = new Set(artifacts.map((artifact) => artifact.state));
    return {
      environmentKey: key,
      state: states.has("unknown") ? "unknown" : states.has("mixed") ? "mixed" : "uniform",
      observedTargetCount: new Set(targets.map((target) => target.targetKey)).size,
      observedArtifactTargetCount: targets.length,
      knownArtifactTargetCount: known.length,
      artifacts,
      deploymentCompleteEstablished: false,
      unobservedTargetsInferred: false,
    };
  });
  const fullHistory = completeTargets.flatMap((target) => target.history.map((entry) => ({
    environmentKey: target.environmentKey,
    targetKey: target.targetKey,
    artifactKey: target.artifactKey,
    ...entry,
  }))).sort((left, right) => left.environmentKey.localeCompare(right.environmentKey)
    || left.targetKey.localeCompare(right.targetKey)
    || left.artifactKey.localeCompare(right.artifactKey)
    || left.sequence - right.sequence
    || left.observationId.localeCompare(right.observationId));
  const returnedHistory = fullHistory.slice(0, boundedHistoryLimit);
  const returnedIds = new Set(returnedHistory.map((entry) => entry.observationId));
  const targets = completeTargets.map((target) => ({
    ...target,
    history: target.history.filter((entry) => returnedIds.has(entry.observationId)),
    historyTotal: target.history.length,
    historyOmitted: target.history.filter((entry) => !returnedIds.has(entry.observationId)).length,
  }));
  const payload = {
    kind: "DeliveryStateProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-delivery-observation"), version: DELIVERY_OBSERVATION_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    status: records.length ? "active" : "not_started",
    filters: { environmentKey: normalizedEnvironment || null, targetKey: normalizedTarget || null },
    environments,
    targets,
    history: {
      total: fullHistory.length,
      returned: returnedHistory.length,
      omitted: Math.max(0, fullHistory.length - returnedHistory.length),
      limit: boundedHistoryLimit,
      complete: fullHistory.length <= boundedHistoryLimit,
    },
    semantics: {
      currentSelectionBasis: "explicit-sequence-and-predecessor-not-receipt-time",
      failedAttemptOverwritesCurrentSuccess: false,
      unobservedTargetSuccessInferred: false,
      deliveryCompletionInferred: false,
      semanticReleaseAuthority: false,
    },
    authority: {
      projection: "P4-derived-nonpersisted",
      observations: "P3-evidence-only",
      productCanon: "unchanged",
      reviewDecision: "unchanged",
      recoveryDirection: "unchanged",
    },
    ordinaryWorkBlocked: false,
  };
  return projectionIdentity(payload);
}
