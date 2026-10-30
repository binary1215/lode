import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { OBSERVATION_PROTOCOL_VERSION, observationCanonicalJson, observationDigest } from "./observation-contract.mjs";
import { loadObservationArtifacts } from "./observation-store.mjs";

const fail = (message, code = "OBSERVATION_PROJECTION_ERROR") => { const error = new Error(message); error.code = code; throw error; };
const OBSERVATION_QUERY_LIMIT = 100;

function edge(type, from, to, evidenceIds) {
  const payload = { type, from, to, evidenceIds: [...new Set(evidenceIds)].sort(), authority: "derived-evidence-relation", instructionAuthority: false, promotionAuthority: false };
  const hash = observationDigest(payload);
  return { edgeId: `observation-edge-${hash.slice(0, 24)}`, ...payload, edgeHash: hash };
}

function projectionPayload({ projectId, descriptors, observations, derivedObservations, receipts }, storage) {
  const nodes = [];
  const edges = [];
  for (const descriptor of descriptors) nodes.push({
    nodeId: descriptor.descriptorId,
    kind: "ObservationTypeDescriptor",
    descriptorHash: descriptor.descriptorHash,
    typeKey: descriptor.typeKey,
    typeVersion: descriptor.typeVersion,
    forms: descriptor.forms,
    authority: descriptor.authority,
    epistemicClass: "derived-projection",
    semanticAuthority: false,
  });
  for (const receipt of receipts) nodes.push({
    nodeId: receipt.receiptId,
    kind: "ObservationCollectionReceipt",
    receiptHash: receipt.receiptHash,
    adapterKey: receipt.adapterKey,
    adapterVersion: receipt.adapterVersion,
    sourceScopeDigest: receipt.sourceScopeDigest,
    authority: receipt.authority,
    epistemicClass: "observed-fact",
    semanticAuthority: false,
  });
  const receiptByObservation = new Map(receipts.map((receipt) => [receipt.observationId, receipt]));
  for (const observation of observations) {
    nodes.push({
      nodeId: observation.observationId,
      kind: "ObservationRecord",
      observationHash: observation.observationHash,
      descriptorId: observation.descriptorId,
      typeKey: observation.typeKey,
      typeVersion: observation.typeVersion,
      subject: observation.subject,
      form: observation.form,
      temporalScope: observation.temporalScope,
      coverage: observation.coverage,
      payload: observation.payload,
      epistemicClass: observation.epistemicClass,
      authority: observation.authority,
      semanticAuthority: false,
      contextEligibility: "exact-evidence-need-only",
    });
    edges.push(edge("CONFORMS_TO", observation.observationId, observation.descriptorId, [observation.observationId, observation.descriptorId]));
    const receipt = receiptByObservation.get(observation.observationId);
    edges.push(edge("EVIDENCED_BY", observation.observationId, receipt.receiptId, [observation.observationId, receipt.receiptId]));
  }
  for (const derived of derivedObservations) {
    nodes.push({
      nodeId: derived.derivedObservationId,
      kind: "DerivedObservationRecord",
      derivedObservationHash: derived.derivedObservationHash,
      descriptorId: derived.descriptorId,
      typeKey: derived.typeKey,
      typeVersion: derived.typeVersion,
      subject: derived.subject,
      form: derived.form,
      temporalScope: derived.temporalScope,
      coverage: derived.coverage,
      payload: derived.payload,
      algorithm: derived.algorithm,
      epistemicClass: derived.epistemicClass,
      authority: derived.authority,
      semanticAuthority: false,
      contextEligibility: "exact-evidence-need-only",
    });
    edges.push(edge("CONFORMS_TO", derived.derivedObservationId, derived.descriptorId, [derived.derivedObservationId, derived.descriptorId]));
    for (const input of derived.inputObservations) edges.push(edge("DERIVED_FROM", derived.derivedObservationId, input.observationId, [derived.derivedObservationId, input.observationId]));
  }
  nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationStatusProjection",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-observation-projection"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId,
    descriptorIds: descriptors.map((item) => item.descriptorId),
    observationIds: observations.map((item) => item.observationId),
    derivedObservationIds: derivedObservations.map((item) => item.derivedObservationId),
    receiptIds: receipts.map((item) => item.receiptId),
    nodes,
    edges,
    graphPolicy: {
      automaticRelations: ["CONFORMS_TO", "DERIVED_FROM", "EVIDENCED_BY"],
      automaticSemanticRelations: false,
      productFeatureLinks: "forbidden-without-existing-candidate-review-flow",
      contextEligibility: "exact-evidence-need-only",
    },
    authority: "rebuildable-observation-view-not-product-or-recovery-canon",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
}

export function verifyObservationProjection(document, projectId = "", storage) {
  const format = familyFormatForOriginal("head-agent-core-observation-projection", document, storage);
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("ObservationStatusProjection is invalid.", "INVALID_OBSERVATION_PROJECTION");
  const payload = { ...document }; delete payload.projectionId; delete payload.projectionHash;
  const hash = observationDigest(payload);
  if (document.projectionId !== `observation-projection-${hash.slice(0, 24)}` || document.projectionHash !== hash
    || document.schemaVersion !== SCHEMA_VERSION || document.kind !== "ObservationStatusProjection"
    || !format || document.protocol?.version !== OBSERVATION_PROTOCOL_VERSION
    || projectId && document.projectId !== projectId || !Array.isArray(document.nodes) || !Array.isArray(document.edges)
    || document.graphPolicy?.automaticSemanticRelations !== false || document.graphPolicy?.contextEligibility !== "exact-evidence-need-only"
    || document.authority !== "rebuildable-observation-view-not-product-or-recovery-canon"
    || document.instructionAuthority !== false || document.promotionAuthority !== false || document.recoveryAuthority !== false) fail("ObservationStatusProjection fields, digest, or authority are invalid.", "INVALID_OBSERVATION_PROJECTION");
  const nodes = new Map(document.nodes.map((node) => [node.nodeId, node]));
  if (nodes.size !== document.nodes.length || new Set(document.edges.map((item) => item.edgeId)).size !== document.edges.length) fail("ObservationStatusProjection contains duplicates.", "INVALID_OBSERVATION_PROJECTION");
  for (const item of document.edges) {
    const edgePayload = { type: item.type, from: item.from, to: item.to, evidenceIds: item.evidenceIds, authority: item.authority, instructionAuthority: item.instructionAuthority, promotionAuthority: item.promotionAuthority };
    const edgeHash = observationDigest(edgePayload);
    if (item.edgeId !== `observation-edge-${edgeHash.slice(0, 24)}` || item.edgeHash !== edgeHash || !nodes.has(item.from) || !nodes.has(item.to)
      || !["CONFORMS_TO", "DERIVED_FROM", "EVIDENCED_BY"].includes(item.type) || item.authority !== "derived-evidence-relation"
      || item.instructionAuthority !== false || item.promotionAuthority !== false) fail("ObservationStatusProjection relation is invalid.", "INVALID_OBSERVATION_PROJECTION_RELATION");
  }
  return document;
}

export function loadObservationProjection({ projectRoot, projectId, artifacts = null, storage = null } = {}) {
  const verifiedArtifacts = artifacts || loadObservationArtifacts({ projectRoot, projectId, storage });
  const payload = projectionPayload({ projectId, ...verifiedArtifacts }, storage);
  const projectionHash = observationDigest(payload);
  return verifyObservationProjection({ ...payload, projectionId: `observation-projection-${projectionHash.slice(0, 24)}`, projectionHash }, projectId, storage);
}

function optionalKey(value, label) {
  const normalized = String(value || "").trim();
  if (normalized && (Buffer.byteLength(normalized, "utf8") > 192 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized))) fail(`${label} is invalid.`, "INVALID_OBSERVATION_QUERY");
  return normalized;
}

function optionalTimestamp(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date-time.`, "INVALID_OBSERVATION_QUERY");
  return new Date(normalized).toISOString();
}

function querySummary(record) {
  const derived = record.kind === "DerivedObservationRecord";
  return {
    observationId: derived ? record.derivedObservationId : record.observationId,
    observationHash: derived ? record.derivedObservationHash : record.observationHash,
    kind: record.kind,
    descriptorId: record.descriptorId,
    typeKey: record.typeKey,
    typeVersion: record.typeVersion,
    subject: record.subject,
    form: record.form,
    observedAt: record.temporalScope.observedAt,
    coverage: {
      state: record.coverage.state,
      examinedCount: record.coverage.examinedCount,
      sourceReportedTotal: record.coverage.sourceReportedTotal,
      omittedCount: record.coverage.omittedCount,
    },
    payloadDigest: observationDigest(record.payload),
    source: derived ? null : {
      adapterKey: record.source.adapterKey,
      adapterVersion: record.source.adapterVersion,
      sourceScopeDigest: record.source.sourceScopeDigest,
      sourceEvidenceDigest: record.source.sourceEvidenceDigest,
    },
    derivation: derived ? {
      algorithm: record.algorithm,
      inputObservationIds: record.inputObservations.map((item) => item.observationId),
    } : null,
    semanticAuthority: false,
    contextEligibility: "exact-evidence-need-only",
  };
}

export function queryObservations({
  root = ".",
  typeKey = "",
  subjectType = "",
  subjectKey = "",
  adapterKey = "",
  observedAfter = "",
  observedBefore = "",
  recordKind = "all",
  limit = 25,
  cursor = "",
  projectionId = "",
} = {}) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for Observation query; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  const normalized = {
    typeKey: optionalKey(typeKey, "Observation query typeKey"),
    subjectType: optionalKey(subjectType, "Observation query subjectType"),
    subjectKey: optionalKey(subjectKey, "Observation query subjectKey"),
    adapterKey: optionalKey(adapterKey, "Observation query adapterKey"),
    observedAfter: optionalTimestamp(observedAfter, "Observation query observedAfter"),
    observedBefore: optionalTimestamp(observedBefore, "Observation query observedBefore"),
    recordKind: String(recordKind || "all").trim(),
  };
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > OBSERVATION_QUERY_LIMIT) fail(`Observation query limit must be between 1 and ${OBSERVATION_QUERY_LIMIT}.`, "INVALID_OBSERVATION_QUERY");
  if (!new Set(["all", "observed", "derived"]).has(normalized.recordKind)) fail("Observation query recordKind is invalid.", "INVALID_OBSERVATION_QUERY");
  const cursorId = String(cursor || "").trim();
  const expectedProjectionId = String(projectionId || "").trim();
  if (Boolean(cursorId) !== Boolean(expectedProjectionId)) fail("Observation query cursor and projectionId must be supplied together.", "INVALID_OBSERVATION_QUERY_CURSOR");
  if (cursorId && !/^(?:observation|derived-observation)-[a-f0-9]{24}$/.test(cursorId)) fail("Observation query cursor is invalid.", "INVALID_OBSERVATION_QUERY_CURSOR");
  if (expectedProjectionId && !/^observation-projection-[a-f0-9]{24}$/.test(expectedProjectionId)) fail("Observation query projectionId is invalid.", "INVALID_OBSERVATION_QUERY_CURSOR");
  if (normalized.observedAfter && normalized.observedBefore && normalized.observedAfter > normalized.observedBefore) fail("Observation query time range is invalid.", "INVALID_OBSERVATION_QUERY");

  const artifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const projection = loadObservationProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, artifacts, storage: inspected.storage });
  if (expectedProjectionId && expectedProjectionId !== projection.projectionId) fail("Observation query cursor projection is stale.", "STALE_OBSERVATION_QUERY_CURSOR");
  const records = [
    ...artifacts.observations,
    ...artifacts.derivedObservations,
  ].filter((record) => {
    const derived = record.kind === "DerivedObservationRecord";
    if (normalized.recordKind === "observed" && derived || normalized.recordKind === "derived" && !derived) return false;
    if (normalized.typeKey && record.typeKey !== normalized.typeKey) return false;
    if (normalized.subjectType && record.subject.type !== normalized.subjectType) return false;
    if (normalized.subjectKey && record.subject.key !== normalized.subjectKey) return false;
    if (normalized.adapterKey && (derived || record.source.adapterKey !== normalized.adapterKey)) return false;
    if (normalized.observedAfter && record.temporalScope.observedAt < normalized.observedAfter) return false;
    if (normalized.observedBefore && record.temporalScope.observedAt > normalized.observedBefore) return false;
    return true;
  }).map(querySummary).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.observationId.localeCompare(b.observationId));

  let start = 0;
  if (cursorId) {
    const index = records.findIndex((item) => item.observationId === cursorId);
    if (index < 0) fail("Observation query cursor is not present in the current filtered projection.", "INVALID_OBSERVATION_QUERY_CURSOR");
    start = index + 1;
  }
  const results = records.slice(start, start + boundedLimit);
  const remaining = Math.max(0, records.length - start - results.length);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationQueryProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-observation-query"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    sourceProjectionId: projection.projectionId,
    sourceProjectionHash: projection.projectionHash,
    inventorySummary: {
      scope: "all-retained-observations",
      status: projection.observationIds.length || projection.derivedObservationIds.length ? "active" : "not_started",
      counts: {
        descriptors: projection.descriptorIds.length,
        observations: projection.observationIds.length,
        derivedObservations: projection.derivedObservationIds.length,
        receipts: projection.receiptIds.length,
        nodes: projection.nodes.length,
        edges: projection.edges.length,
      },
      graphPolicy: projection.graphPolicy,
    },
    filters: normalized,
    limit: boundedLimit,
    totalMatches: records.length,
    returned: results.length,
    omitted: remaining,
    results,
    nextCursor: remaining && results.length ? { projectionId: projection.projectionId, observationId: results.at(-1).observationId } : null,
    semanticSelection: false,
    authority: "bounded-p4-observation-discovery-not-semantic-selection",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const queryHash = observationDigest(payload);
  return { ...payload, queryId: `observation-query-${queryHash.slice(0, 24)}`, queryHash };
}

export function observationProjectionEvidenceDigest(projection) {
  return observationDigest(observationCanonicalJson(verifyObservationProjection(projection)));
}
