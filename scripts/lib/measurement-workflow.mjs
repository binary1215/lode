import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import {
  createObservationTypeDescriptor,
  observationDigest,
  stableKey,
} from "./observation-contract.mjs";
import {
  assertObservationProjectReady,
  loadObservationArtifacts,
  readObservation,
  recordCollectedObservation,
  recordDerivedObservation,
  registerObservationType,
} from "./observation-store.mjs";
import { buildWorldModel, inspectWorldModel, queryWorldTemporalGraph } from "./world-model.mjs";
import { recordProductHypothesis } from "./product-operating-loop.mjs";

export const MEASUREMENT_WORKFLOW_VERSION = "0.1.0";
const METRIC_PREFIX = "metric.";
const DIRECTIONS = new Set(["increase", "decrease", "maintain"]);
const ASSESSMENTS = new Set(["supports", "contradicts", "inconclusive"]);

const fail = (message, code = "MEASUREMENT_WORKFLOW_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function requiredText(value, label, max = 1000) {
  const normalized = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > max) fail(`${label} is invalid.`, "INVALID_MEASUREMENT_INPUT");
  return normalized;
}

function timestamp(value, label) {
  const normalized = requiredText(value, label, 64);
  if (Number.isNaN(Date.parse(normalized))) fail(`${label} must be an ISO date-time.`, "INVALID_MEASUREMENT_INPUT");
  return new Date(normalized).toISOString();
}

function metricTypeKey(metricKey) { return `${METRIC_PREFIX}${stableKey(metricKey, "Metric key", 128)}`; }

function metricDescriptor({ metricKey, unit, direction, typeVersion = "1" }, storage) {
  const normalizedUnit = stableKey(unit, "Metric unit", 64);
  const normalizedDirection = requiredText(direction, "Metric direction", 16).toLowerCase();
  if (!DIRECTIONS.has(normalizedDirection)) fail("Metric direction must be increase, decrease, or maintain.", "INVALID_MEASUREMENT_INPUT");
  return createObservationTypeDescriptor({
    typeKey: metricTypeKey(metricKey),
    typeVersion: stableKey(typeVersion, "Metric type version", 64),
    forms: ["aggregate", "snapshot"],
    payloadSchema: {
      fields: [
        { key: "desired_direction", type: "enum", required: true, enum: [normalizedDirection] },
        { key: "sample_size", type: "nonnegative-integer", required: false },
        { key: "unit", type: "enum", required: true, enum: [normalizedUnit] },
        { key: "value", type: "bounded-number", required: true },
      ],
      additionalFields: false,
    },
  }, storage);
}

function descriptorDefinition(descriptor) {
  const field = (key) => descriptor.payloadSchema.fields.find((item) => item.key === key);
  if (!descriptor.typeKey.startsWith(METRIC_PREFIX) || field("value")?.type !== "bounded-number"
    || field("unit")?.type !== "enum" || field("unit").enum?.length !== 1
    || field("desired_direction")?.type !== "enum" || field("desired_direction").enum?.length !== 1) {
    fail("ObservationTypeDescriptor is not a HEAD metric definition.", "INVALID_METRIC_DEFINITION");
  }
  return {
    kind: "MetricDefinitionProjection",
    metricKey: descriptor.typeKey.slice(METRIC_PREFIX.length),
    unit: field("unit").enum[0],
    direction: field("desired_direction").enum[0],
    descriptorId: descriptor.descriptorId,
    descriptorHash: descriptor.descriptorHash,
    typeVersion: descriptor.typeVersion,
    authority: "P3-data-shape-and-measurement-proposal-not-product-canon",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
}

function findMetricDefinition(projectRoot, projectId, metricKey, typeVersion = "", storage) {
  const artifacts = loadObservationArtifacts({ projectRoot, projectId, storage });
  const typeKey = metricTypeKey(metricKey);
  const matches = artifacts.descriptors.filter((item) => item.typeKey === typeKey && (!typeVersion || item.typeVersion === typeVersion));
  if (!matches.length) fail(`Metric definition is missing: ${metricKey}`, "METRIC_DEFINITION_NOT_FOUND");
  if (!typeVersion && matches.length > 1) fail(`Metric ${metricKey} has multiple versions; select typeVersion explicitly.`, "METRIC_VERSION_REQUIRED");
  if (typeVersion && matches.length > 1) fail(`Metric ${metricKey} version ${typeVersion} has conflicting definitions.`, "METRIC_DEFINITION_AMBIGUOUS");
  const descriptor = matches[0];
  return { descriptor, definition: descriptorDefinition(descriptor) };
}

function comparisonState(left, right) {
  if (left == null || right == null) return "unknown";
  return left === right ? "same" : "different";
}

function periodDurationMs(record) {
  const start = record.temporalScope?.start;
  const end = record.temporalScope?.end;
  if (start == null || end == null) return null;
  return Date.parse(end) - Date.parse(start);
}

function collectionComparability(baseline, current) {
  const sourceScope = comparisonState(baseline.record.source.sourceScopeDigest, current.record.source.sourceScopeDigest);
  const adapterKey = comparisonState(baseline.record.source.adapterKey, current.record.source.adapterKey);
  const adapterVersion = comparisonState(baseline.record.source.adapterVersion, current.record.source.adapterVersion);
  const adapterDescriptor = comparisonState(baseline.receipt?.adapterDescriptorDigest ?? null, current.receipt?.adapterDescriptorDigest ?? null);
  const form = comparisonState(baseline.record.form, current.record.form);
  const duration = comparisonState(periodDurationMs(baseline.record), periodDurationMs(current.record));
  const sampleSize = comparisonState(baseline.record.payload.sample_size ?? null, current.record.payload.sample_size ?? null);
  const coverageState = comparisonState(baseline.record.coverage.state, current.record.coverage.state);
  const conditionsEquivalent = [sourceScope, adapterKey, adapterVersion, adapterDescriptor, form, duration, sampleSize, coverageState].every((state) => state === "same");
  return {
    sourceScope: {
      state: sourceScope,
      baselineDigest: baseline.record.source.sourceScopeDigest,
      currentDigest: current.record.source.sourceScopeDigest,
    },
    adapter: {
      key: { state: adapterKey, baseline: baseline.record.source.adapterKey, current: current.record.source.adapterKey },
      version: { state: adapterVersion, baseline: baseline.record.source.adapterVersion, current: current.record.source.adapterVersion },
      descriptorDigest: { state: adapterDescriptor, baseline: baseline.receipt?.adapterDescriptorDigest ?? null, current: current.receipt?.adapterDescriptorDigest ?? null },
    },
    form: { state: form, baseline: baseline.record.form, current: current.record.form },
    duration: { state: duration, baselineMs: periodDurationMs(baseline.record), currentMs: periodDurationMs(current.record) },
    sampleSize: { state: sampleSize, baseline: baseline.record.payload.sample_size ?? null, current: current.record.payload.sample_size ?? null },
    coverage: { state: coverageState, baseline: baseline.record.coverage.state, current: current.record.coverage.state },
    normalizationApplied: false,
    conditionsEquivalent,
    interpretation: conditionsEquivalent
      ? "like-for-like-under-the-recorded-collection-conditions"
      : "conditional-on-the-disclosed-collection-condition-differences-or-unknowns",
  };
}

function normalizeCoverage(value = {}) {
  const state = String(value.state || "unknown").trim();
  if (!["complete", "sampled", "partial", "unknown"].includes(state)) fail("Metric coverage state is invalid.", "INVALID_MEASUREMENT_COVERAGE");
  const examinedCount = value.examinedCount == null ? 1 : Number(value.examinedCount);
  const sourceReportedTotal = value.sourceReportedTotal == null ? null : Number(value.sourceReportedTotal);
  const omittedCount = value.omittedCount == null ? null : Number(value.omittedCount);
  const queryDigest = value.queryDigest == null ? null : requiredText(value.queryDigest, "Metric coverage queryDigest", 64);
  if (!Number.isInteger(examinedCount) || examinedCount < 0) fail("Metric coverage examinedCount is invalid.", "INVALID_MEASUREMENT_COVERAGE");
  if (state === "complete" && (!/^[a-f0-9]{64}$/.test(queryDigest || "") || sourceReportedTotal !== examinedCount || omittedCount !== 0)) {
    fail("Complete metric coverage requires an exact query digest, matching total, and zero omission.", "UNPROVEN_COMPLETE_MEASUREMENT_COVERAGE");
  }
  return {
    state,
    basis: state === "complete" ? "enumerated-bounded-query" : stableKey(value.basis || "source-reported", "Metric coverage basis", 128),
    queryDigest,
    examinedCount,
    sourceReportedTotal,
    omittedCount,
    cursorStartDigest: value.cursorStartDigest ?? null,
    cursorEndDigest: value.cursorEndDigest ?? null,
  };
}

async function projectCurrentObservations(root) {
  const world = await buildWorldModel({ root, persist: true });
  return { worldModelId: world.snapshot.worldModelId, graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId };
}

// Call only after the complete primary store operation has returned. A failed
// derived update neither erases committed evidence nor schedules a retry.
async function projectCommittedObservations(root) {
  try { return await projectCurrentObservations(root); }
  catch (error) {
    const reasonCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(error.code)
      ? error.code : "MEASUREMENT_PROJECTION_FAILED";
    return { status: "deferred", reasonCode, ordinaryWorkBlocked: false };
  }
}

export async function defineMetric({ root = ".", metricKey, unit, direction, typeVersion = "1" } = {}) {
  const inspected = assertObservationProjectReady(root);
  const descriptor = metricDescriptor({ metricKey, unit, direction, typeVersion }, inspected.storage);
  const existing = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage })
    .descriptors.filter((item) => item.typeKey === descriptor.typeKey && item.typeVersion === descriptor.typeVersion);
  if (existing.some((item) => item.descriptorHash !== descriptor.descriptorHash)) {
    fail(`Metric ${metricKey} version ${typeVersion} already has a different definition. Use a new typeVersion.`, "METRIC_DEFINITION_CONFLICT");
  }
  const persisted = registerObservationType({ root: inspected.project.projectRoot, descriptor });
  return {
    status: persisted.status,
    definition: descriptorDefinition(descriptor),
    descriptor,
    worldModel: await projectCommittedObservations(inspected.project.projectRoot),
    ordinaryWorkBlocked: false,
  };
}

export async function recordMetricObservation({
  root = ".", metricKey, typeVersion = "", subjectType, subjectKey, value, sampleSize = null,
  form = "snapshot", observedAt = null, start = null, end = null,
  coverage = {}, adapterKey, adapterVersion = MEASUREMENT_WORKFLOW_VERSION,
  sourceScopeDigest, sourceEventKeyDigest, sourceEvidenceDigest,
} = {}) {
  const inspected = assertObservationProjectReady(root);
  if (!Number.isFinite(value)) fail("Metric value must be finite.", "INVALID_MEASUREMENT_INPUT");
  if (!new Set(["snapshot", "aggregate"]).has(form)) fail("Metric form must be snapshot or aggregate.", "INVALID_MEASUREMENT_INPUT");
  if (form === "aggregate" && (start == null || end == null)) fail("Aggregate metrics require start and end.", "INVALID_MEASUREMENT_INPUT");
  const selected = findMetricDefinition(inspected.project.projectRoot, inspected.project.projectId, metricKey, typeVersion, inspected.storage);
  const normalizedAdapterKey = stableKey(adapterKey === undefined ? formatForVerifiedOwner(inspected.storage).value("head.metric-host-input") : adapterKey, "Metric adapter key", 192);
  const normalizedAdapterVersion = stableKey(adapterVersion, "Metric adapter version", 64);
  const normalizedSourceScopeDigest = requiredText(sourceScopeDigest, "Metric sourceScopeDigest", 64);
  const normalizedSourceEventKeyDigest = requiredText(sourceEventKeyDigest, "Metric sourceEventKeyDigest", 64);
  const existingReplay = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage }).observations.find((record) => (
    record.source.adapterKey === normalizedAdapterKey
    && record.source.adapterVersion === normalizedAdapterVersion
    && record.source.sourceScopeDigest === normalizedSourceScopeDigest
    && record.source.sourceEventKeyDigest === normalizedSourceEventKeyDigest
  ));
  const effectiveObservedAt = observedAt == null ? existingReplay?.temporalScope.observedAt || new Date().toISOString() : observedAt;
  const payload = {
    desired_direction: selected.definition.direction,
    unit: selected.definition.unit,
    value,
    ...(sampleSize == null ? {} : { sample_size: Number(sampleSize) }),
  };
  const recorded = recordCollectedObservation({
    root: inspected.project.projectRoot,
    descriptor: selected.descriptor,
    input: {
      subject: { type: stableKey(subjectType, "Metric subject type", 192), key: stableKey(subjectKey, "Metric subject key", 192) },
      form,
      temporalScope: { observedAt: timestamp(effectiveObservedAt, "Metric observedAt"), start: start == null ? null : timestamp(start, "Metric start"), end: end == null ? null : timestamp(end, "Metric end") },
      sourceEventKeyDigest: normalizedSourceEventKeyDigest,
      sourceEvidenceDigest: requiredText(sourceEvidenceDigest, "Metric sourceEvidenceDigest", 64),
      coverage: normalizeCoverage(coverage),
      payload,
    },
    adapterDescriptor: { adapterKey: normalizedAdapterKey, adapterVersion: normalizedAdapterVersion, authority: "host-observation-evidence-only", providerNeutral: true },
    sourceScopeDigest: normalizedSourceScopeDigest,
  });
  return { ...recorded, definition: selected.definition, worldModel: await projectCommittedObservations(inspected.project.projectRoot), ordinaryWorkBlocked: false };
}

function observedMetric(read) {
  const record = read.observation;
  if (record.kind !== "ObservationRecord" || !record.typeKey.startsWith(METRIC_PREFIX)) fail("Metric comparison inputs must be collected metric observations.", "INCOMPARABLE_METRIC_OBSERVATIONS");
  const definition = descriptorDefinition(read.descriptor);
  return { record, definition, receipt: read.receipt };
}

export async function compareMetricObservations({ root = ".", baselineObservationId, currentObservationId } = {}) {
  const inspected = assertObservationProjectReady(root);
  const baseline = observedMetric(readObservation({ root: inspected.project.projectRoot, observationId: baselineObservationId }));
  const current = observedMetric(readObservation({ root: inspected.project.projectRoot, observationId: currentObservationId }));
  if (baseline.record.observationId === current.record.observationId) fail("Metric comparison requires two different observations.", "INCOMPARABLE_METRIC_OBSERVATIONS");
  if (baseline.record.descriptorId !== current.record.descriptorId
    || baseline.record.subject.type !== current.record.subject.type || baseline.record.subject.key !== current.record.subject.key
    || baseline.record.payload.unit !== current.record.payload.unit || baseline.record.payload.desired_direction !== current.record.payload.desired_direction) {
    fail("Metric observations differ in definition, subject, unit, or direction.", "INCOMPARABLE_METRIC_OBSERVATIONS");
  }
  if (Date.parse(baseline.record.temporalScope.observedAt) > Date.parse(current.record.temporalScope.observedAt)) fail("Metric baseline must not be observed after current.", "INCOMPARABLE_METRIC_OBSERVATIONS");
  const comparisonDescriptor = createObservationTypeDescriptor({
    typeKey: `${baseline.record.typeKey}.comparison`,
    typeVersion: baseline.record.typeVersion,
    forms: ["aggregate"],
    payloadSchema: { fields: [
      { key: "absolute_change", type: "bounded-number", required: true },
      { key: "baseline_value", type: "bounded-number", required: true },
      { key: "current_value", type: "bounded-number", required: true },
      { key: "desired_direction", type: "enum", required: true, enum: [baseline.record.payload.desired_direction] },
      { key: "relative_change", type: "bounded-number", required: false },
      { key: "unit", type: "enum", required: true, enum: [baseline.record.payload.unit] },
    ], additionalFields: false },
  }, inspected.storage);
  const absoluteChange = current.record.payload.value - baseline.record.payload.value;
  const payload = {
    baseline_value: baseline.record.payload.value,
    current_value: current.record.payload.value,
    absolute_change: absoluteChange,
    ...(baseline.record.payload.value === 0 ? {} : { relative_change: absoluteChange / Math.abs(baseline.record.payload.value) }),
    unit: baseline.record.payload.unit,
    desired_direction: baseline.record.payload.desired_direction,
  };
  const exactInputs = [baseline.record.observationId, current.record.observationId].sort();
  const inputsComplete = baseline.record.coverage.state === "complete" && current.record.coverage.state === "complete";
  const collectionConditions = collectionComparability(baseline, current);
  const comparisonCoverageComplete = inputsComplete && collectionConditions.conditionsEquivalent;
  const comparison = recordDerivedObservation({
    root: inspected.project.projectRoot,
    descriptor: comparisonDescriptor,
    input: {
      subject: baseline.record.subject,
      temporalScope: {
        observedAt: current.record.temporalScope.observedAt,
        start: baseline.record.temporalScope.start || baseline.record.temporalScope.observedAt,
        end: current.record.temporalScope.end || current.record.temporalScope.observedAt,
      },
      inputObservationIds: exactInputs,
      algorithm: { key: formatForVerifiedOwner(inspected.storage).value("head.metric-difference"), version: MEASUREMENT_WORKFLOW_VERSION, digest: observationDigest(formatForVerifiedOwner(inspected.storage).value("head.metric-difference/0.1.0")) },
      coverage: comparisonCoverageComplete ? {
        state: "complete", basis: "enumerated-bounded-query", queryDigest: observationDigest(exactInputs), examinedCount: 2, sourceReportedTotal: 2, omittedCount: 0, cursorStartDigest: null, cursorEndDigest: null,
      } : {
        state: "partial", basis: "bounded-selected-observations", queryDigest: observationDigest(exactInputs), examinedCount: 2, sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null,
      },
      payload,
    },
  });
  return {
    ...comparison,
    comparison: comparison.derivedObservation,
    comparability: {
      exactDefinition: true,
      exactSubject: true,
      exactUnit: true,
      orderedTime: true,
      underlyingCoverageComplete: inputsComplete,
      numericComparisonAvailable: true,
      recordedCollectionConditionsEquivalent: collectionConditions.conditionsEquivalent,
      semanticEquivalenceEstablished: false,
      semanticEquivalenceAssessment: "not-assessed",
      collectionConditions,
    },
    causalityEstablished: false,
    worldModel: await projectCommittedObservations(inspected.project.projectRoot),
    ordinaryWorkBlocked: false,
  };
}

export async function assessMetricComparison({ root = ".", comparisonObservationId, assessment, statement, rationale = "" } = {}) {
  const inspected = assertObservationProjectReady(root);
  const read = readObservation({ root: inspected.project.projectRoot, observationId: comparisonObservationId });
  if (read.observation.kind !== "DerivedObservationRecord" || !read.observation.typeKey.startsWith(METRIC_PREFIX) || !read.observation.typeKey.endsWith(".comparison")) {
    fail("Metric assessment requires an exact derived metric comparison.", "INVALID_METRIC_ASSESSMENT");
  }
  const normalizedAssessment = requiredText(assessment, "Metric assessment", 32).toLowerCase();
  if (!ASSESSMENTS.has(normalizedAssessment)) fail("Metric assessment must be supports, contradicts, or inconclusive.", "INVALID_METRIC_ASSESSMENT");
  const hypothesis = await recordProductHypothesis({
    root: inspected.project.projectRoot,
    statement: `[${normalizedAssessment}] ${requiredText(statement, "Metric assessment statement", 4000)}`,
    rationale: `${requiredText(rationale || "Interpretation is conditional on the exact comparison and its disclosed coverage.", "Metric assessment rationale", 4000)} Causality is not established.`,
    observationIds: [comparisonObservationId],
  });
  return {
    status: "assessment-recorded",
    assessment: normalizedAssessment,
    hypothesis: hypothesis.hypothesis,
    productGraph: hypothesis.productGraph,
    causalityEstablished: false,
    ordinaryWorkBlocked: false,
    conformanceQueueMutated: false,
  };
}

export function inspectMeasurements({ root = "." } = {}) {
  const inspected = assertObservationProjectReady(root);
  const artifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const definitions = artifacts.descriptors.filter((item) => item.typeKey.startsWith(METRIC_PREFIX) && !item.typeKey.endsWith(".comparison")).map(descriptorDefinition);
  const observations = artifacts.observations.filter((item) => item.typeKey.startsWith(METRIC_PREFIX));
  const comparisons = artifacts.derivedObservations.filter((item) => item.typeKey.startsWith(METRIC_PREFIX) && item.typeKey.endsWith(".comparison"));
  return {
    status: definitions.length || observations.length || comparisons.length ? "active" : "not-started",
    definitions,
    observationCount: observations.length,
    comparisonCount: comparisons.length,
    ordinaryWorkBlocked: false,
    authority: { definitions: "P3-data-shape-proposals", observations: "P3-evidence", comparisons: "P3-derived-evidence", graph: "P4-derived", canon: "unchanged", recovery: "unchanged" },
  };
}

export async function traceMeasurementLineage({ root = ".", anchorId = "", metricKey = "", typeVersion = "", depth = 3, maxNodes = 128, maxEdges = 256, graphProjectionAdapter = null } = {}) {
  const inspected = assertObservationProjectReady(root);
  if (anchorId && metricKey) fail("Select either an exact measurement anchor or a metric key, not both.", "INVALID_MEASUREMENT_TRACE_INPUT");
  let selectedAnchorId = String(anchorId || "").trim();
  if (!selectedAnchorId && metricKey) selectedAnchorId = findMetricDefinition(inspected.project.projectRoot, inspected.project.projectId, metricKey, typeVersion, inspected.storage).descriptor.descriptorId;
  if (!selectedAnchorId) fail("Measurement lineage requires an exact anchorId or metricKey.", "MEASUREMENT_TRACE_ANCHOR_REQUIRED");
  const currentWorld = (await inspectWorldModel({ root: inspected.project.projectRoot }));
  if (currentWorld.status !== "current") fail("Measurement lineage requires the current verified World Model.", "WORLD_MODEL_STALE");
  const queryParameters = {
    anchorIds: [selectedAnchorId],
    expectedGraphSnapshotId: currentWorld.snapshot.temporalProvenanceGraph.graphSnapshotId,
    kinds: [
      "ObservationTypeDescriptor", "ObservationCollectionReceipt", "ObservationRecord", "DerivedObservationRecord",
      "ProductHypothesis", "ProductInitiativeCandidate", "ProductInitiativeReviewDecision", "ReviewedProductInitiative",
    ],
    relations: ["CONFORMS_TO", "EVIDENCED_BY", "DERIVED_FROM", "REFERENCES", "SUPPORTED_BY", "PROPOSES_FROM", "REVIEWED_BY", "ACCEPTED_BY", "REJECTED_BY", "PRODUCES", "PROMOTED_FROM"],
    authorityClasses: ["derived", "runtime-observed", "reviewed"],
    freshness: ["current", "historical", "stale"],
    includeUnreviewedCandidates: true,
    depth,
    maxNodes,
    maxEdges,
  };
  const graph = (await queryWorldTemporalGraph({ root: inspected.project.projectRoot, graphProjectionAdapter, ...queryParameters }));
  return {
    kind: "MeasurementLineageProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-measurement-lineage"), version: MEASUREMENT_WORKFLOW_VERSION },
    projectId: inspected.project.projectId,
    anchorId: selectedAnchorId,
    queryParameters,
    graph,
    semantics: { correlationImpliesCausation: false, graphWritesCanon: false, graphWritesRecoveryDirection: false, partialCoverageHidden: false },
    authority: { plane: "P4-derived-read-only", persisted: false, instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, ordinaryWorkBlocked: false },
  };
}
