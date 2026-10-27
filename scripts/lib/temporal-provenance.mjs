import crypto from "node:crypto";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { onboardingCandidateProducerReviewDecisionId, verifyOnboardingGraphProjectionInput } from "./onboarding-projection.mjs";
import { verifyFeatureMappingProjectionInput } from "./feature-mapping-projection.mjs";
import { verifyChangeSetProjectionInput } from "./change-set-projection.mjs";
import { verifyDocumentChangeProjectionInput } from "./document-change-projection.mjs";
import { verifyProductOperatingProjectionInput } from "./product-operating-projection.mjs";
import { verifyReleaseObservationProjectionInput } from "./release-observation-projection.mjs";
import { verifyObservationProjection } from "./observation-projection.mjs";
import { emptyProductModelDocument, normalizeProductModelDocument } from "./product-model.mjs";

import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";

export const TEMPORAL_PROVENANCE_VERSION = "0.15.0";
export const TEMPORAL_TRAVERSAL_VERSION = "0.3.0";

// Internal request ownership, not a caller-supplied verification verdict. Only
// a deeply immutable copy made here can reuse its first successful validation.
// External objects (including frozen lookalikes) always take the full verifier.
const temporalVerificationScopes = new WeakMap();
const ownedTemporalGraphs = new WeakMap();
function freezeOwnedJsonGraph(graph) {
  const objects = new Set(), pending = [graph];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || objects.has(value)) continue;
    // Object.freeze does not make Map/Date/typed-array internal slots immutable.
    // Such adapter values retain normal full validation, without a new gate.
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    objects.add(value);
    for (const nested of Object.values(value)) pending.push(nested);
  }
  for (const value of objects) Object.freeze(value);
  return true;
}
export function createTemporalVerificationScope() {
  const state = { active: true, graphs: new Set() };
  const scope = Object.freeze({ close() {
    if (!state.active) return;
    state.active = false;
    for (const graph of state.graphs) ownedTemporalGraphs.delete(graph);
    state.graphs.clear();
  } });
  temporalVerificationScopes.set(scope, state);
  return scope;
}
export function ownWorldSnapshotForTemporalScope(scope, snapshot) {
  const state = temporalVerificationScopes.get(scope);
  if (!state) fail("Temporal verification scope is not owned by this reader.", "INVALID_TEMPORAL_VERIFICATION_SCOPE");
  if (!state.active) fail("Temporal verification scope is closed.", "TEMPORAL_VERIFICATION_SCOPE_CLOSED");
  // Detach all retained-store aliases before validation or an await. Never
  // freeze the adapter's original, nor its public ordinary-read results.
  let owned;
  try { owned = structuredClone(snapshot); }
  catch (error) {
    // Some accepted custom stores carry unused function-valued extensions.
    // Do not turn a copying optimization into a stricter input contract: keep
    // the original object and every full validation, without freezing/memoing.
    if (error?.name === "DataCloneError") return snapshot;
    throw error;
  }
  const graph = owned?.temporalProvenanceGraph;
  if (graph && typeof graph === "object" && freezeOwnedJsonGraph(graph)) {
    ownedTemporalGraphs.set(graph, { state, verified: false });
    state.graphs.add(graph);
  }
  return owned;
}
const TEMPORAL_RELATION_TYPES_V02 = Object.freeze([
  "CONTAINS",
  "REALIZES",
  "GOVERNED_BY",
  "HAS_REVISION",
  "CURRENT_REVISION",
  "PARENT_OF",
  "DECLARES",
  "REFERENCES",
]);
const TEMPORAL_RELATION_TYPES_V03 = Object.freeze([
  ...TEMPORAL_RELATION_TYPES_V02,
  "PROPOSES_FROM",
  "PROPOSES_TO",
  "SUPPORTED_BY",
  "REVIEWED_BY",
  "ACCEPTED_BY",
  "REJECTED_BY",
  "PROMOTED_FROM",
  "PRODUCES",
]);
const TEMPORAL_RELATION_TYPES_V04 = Object.freeze([
  ...TEMPORAL_RELATION_TYPES_V03,
  "IMPLEMENTS",
  "VERIFIED_BY",
]);
const TEMPORAL_RELATION_TYPES_V05 = Object.freeze([
  ...TEMPORAL_RELATION_TYPES_V04,
  "CHANGES",
  "IMPACTS",
  "SUPERSEDES",
]);
const TEMPORAL_RELATION_TYPES_V06 = Object.freeze([
  ...TEMPORAL_RELATION_TYPES_V05,
  "MATERIALIZED_AS",
]);
const TEMPORAL_RELATION_TYPES_V07 = Object.freeze([...TEMPORAL_RELATION_TYPES_V06]);
const TEMPORAL_RELATION_TYPES_V10 = Object.freeze([...TEMPORAL_RELATION_TYPES_V07, "OBSERVES"]);
const TEMPORAL_RELATION_TYPES_V11 = Object.freeze([...TEMPORAL_RELATION_TYPES_V10, "AT_REVISION", "OBSERVED_ON", "EVIDENCED_BY", "DEPLOYS"]);
const TEMPORAL_RELATION_TYPES_V14 = Object.freeze([...TEMPORAL_RELATION_TYPES_V11, "CONFORMS_TO", "DERIVED_FROM"]);
export const TEMPORAL_RELATION_TYPES = Object.freeze([...TEMPORAL_RELATION_TYPES_V14, "HISTORICALLY_FOLLOWS"]);

const TEMPORAL_NODE_KINDS_V02 = Object.freeze([
  "Repository",
  "File",
  "FileRevision",
  "Symbol",
  "SymbolRevision",
  "Test",
  "TestRevision",
  "FeatureGroup",
  "FeatureGroupRevision",
  "Capability",
  "CapabilityRevision",
  "Feature",
  "FeatureRevision",
  "Requirement",
  "RequirementRevision",
  "Constraint",
  "ConstraintRevision",
  "Decision",
  "DecisionRevision",
  "SourceSnapshot",
  "SourceSnapshotReference",
  "RevisionReference",
]);
const TEMPORAL_NODE_KINDS_V03 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V02,
  "OnboardingCandidateSet",
  "OnboardingProductCandidate",
  "OnboardingEvidence",
  "OnboardingUnknown",
  "OnboardingReviewDecision",
  "ProductConceptReference",
  "ProductModelRevision",
]);
const TEMPORAL_NODE_KINDS_V04 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V03,
  "FeatureMappingCandidateSet",
  "FeatureMappingCandidate",
  "FeatureMappingEvidence",
  "FeatureMappingUnknown",
  "FeatureMappingReviewDecision",
  "ReviewedRelationship",
  "MappingEndpointReference",
]);
const TEMPORAL_NODE_KINDS_V05 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V04,
  "ChangeSet",
  "ChangeRevisionReference",
  "ExecutionLineageReference",
  "ChangeImpactCandidateSet",
  "ChangeImpactCandidate",
  "ChangeImpactUnknown",
  "ChangeImpactReviewDecision",
  "ReviewedImpact",
  "ChangeProductReference",
]);
const TEMPORAL_NODE_KINDS_V06 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V05,
  "VcsEvidence",
  "GitCommit",
]);
const TEMPORAL_NODE_KINDS_V07 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V06,
  "DocumentChangeCandidateSet",
  "DocumentChangeCandidate",
  "DocumentChangeReviewDecision",
  "DocumentChangeApplication",
  "DocumentProductModelRevision",
  "DocumentProjectionReference",
]);
const TEMPORAL_NODE_KINDS_V10 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V07,
  "ProductSignal",
  "ProductHypothesis",
  "ProductInitiativeCandidate",
  "ProductInitiativeReviewDecision",
  "ReviewedProductInitiative",
  "ProductFeatureCandidate",
  "ProductFeatureReference",
  "OutcomeObservation",
]);
const TEMPORAL_NODE_KINDS_V11 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V10,
  "BranchStateObservation",
  "DeploymentResultObservation",
  "ReleaseObservation",
]);
const TEMPORAL_NODE_KINDS_V13 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V11,
  "ObservationTypeDescriptor",
  "ObservationCollectionReceipt",
  "ObservationRecord",
  "DerivedObservationRecord",
]);
const TEMPORAL_NODE_KINDS_V14 = Object.freeze([
  ...TEMPORAL_NODE_KINDS_V13,
  "Policy",
  "PolicyRevision",
  "ProductModelRevisionReference",
  "ProductPolicyCandidate",
  "ProductPolicyEvidence",
  "ProductPolicyReviewDecision",
]);
export const TEMPORAL_NODE_KINDS = Object.freeze([...TEMPORAL_NODE_KINDS_V14, "HistoricalOnboardingCandidateReference"]);

const PRODUCER = "head-agent-core-temporal-provenance";
const AUTHORITY_CLASSES = new Set(["canon-projected", "reviewed", "derived", "heuristic", "runtime-observed"]);
const FRESHNESS_STATES = new Set(["current", "stale", "historical"]);
const PRODUCT_DEFINITIONS = Object.freeze({
  FeatureGroup: { collection: "featureGroups", prefix: "feature-group", revisionPrefix: "feature-group-revision" },
  Capability: { collection: "capabilities", prefix: "capability", revisionPrefix: "capability-revision" },
  Feature: { collection: "features", prefix: "feature", revisionPrefix: "feature-revision" },
  Requirement: { collection: "requirements", prefix: "requirement", revisionPrefix: "requirement-revision" },
  Constraint: { collection: "constraints", prefix: "constraint", revisionPrefix: "constraint-revision" },
  Decision: { collection: "decisions", prefix: "decision", revisionPrefix: "decision-revision" },
  Policy: { collection: "policies", prefix: "policy", revisionPrefix: "policy-revision" },
});

const fail = (message, code = "TEMPORAL_PROVENANCE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

export function deduplicateTemporalEdgesInPlace(edges) {
  if (!Array.isArray(edges)) fail("Temporal edges must be an array.", "TEMPORAL_EDGES_REQUIRED");
  const uniqueEdges = new Map();
  for (const edge of edges) {
    const existing = uniqueEdges.get(edge.edgeId);
    if (existing && canonicalJson(existing) !== canonicalJson(edge)) {
      fail(`Temporal edge identity collision: ${edge.edgeId}`, "TEMPORAL_EDGE_IDENTITY_COLLISION");
    }
    uniqueEdges.set(edge.edgeId, edge);
  }
  edges.length = 0;
  for (const edge of uniqueEdges.values()) edges.push(edge);
  return edges;
}

function identity(prefix, value) {
  return `${prefix}-${digest(canonicalJson(value)).slice(0, 24)}`;
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`, "INVALID_TEMPORAL_PARENT_SET");
  const normalized = values.map((value) => String(value || "").trim());
  if (normalized.some((value) => !value)) fail(`${label} contains an empty identity.`, "INVALID_TEMPORAL_PARENT_SET");
  return [...new Set(normalized)].sort();
}

export function normalizeParentSourceSnapshotIds(values = []) {
  const normalized = sortedUniqueStrings(values, "parentSourceSnapshotIds");
  for (const value of normalized) {
    if (!/^source-snapshot-[a-f0-9]{24}$/.test(value)) {
      fail(`Invalid parent SourceSnapshot identity: ${value}`, "INVALID_SOURCE_SNAPSHOT_PARENT");
    }
  }
  return normalized;
}

export function normalizeRevisionParentIds(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("revisionParentIds must be an object keyed by logical entity identity.", "INVALID_REVISION_PARENT_SET");
  }
  const normalized = {};
  for (const logicalEntityId of Object.keys(value).sort()) {
    const parents = sortedUniqueStrings(value[logicalEntityId], `revisionParentIds.${logicalEntityId}`);
    normalized[logicalEntityId] = parents;
  }
  return normalized;
}

export function normalizeLogicalLineageState(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("logicalLineageState must be an object.", "INVALID_LOGICAL_LINEAGE_STATE");
  }
  const rawGenerations = value.continuityGenerationByLogicalEntityId || {};
  if (!rawGenerations || typeof rawGenerations !== "object" || Array.isArray(rawGenerations)) {
    fail("logicalLineageState.continuityGenerationByLogicalEntityId must be an object.", "INVALID_LOGICAL_LINEAGE_STATE");
  }
  const continuityGenerationByLogicalEntityId = {};
  for (const logicalEntityId of Object.keys(rawGenerations).sort()) {
    const generation = rawGenerations[logicalEntityId];
    if (!logicalEntityId || !Number.isSafeInteger(generation) || generation < 1) {
      fail("Logical continuity generations must use non-empty identities and positive safe integers.", "INVALID_LOGICAL_LINEAGE_STATE");
    }
    continuityGenerationByLogicalEntityId[logicalEntityId] = generation;
  }
  const normalized = {
    discontinuousLogicalEntityIds: sortedUniqueStrings(value.discontinuousLogicalEntityIds || [], "logicalLineageState.discontinuousLogicalEntityIds"),
    retiredLogicalEntityIds: sortedUniqueStrings(value.retiredLogicalEntityIds || [], "logicalLineageState.retiredLogicalEntityIds"),
    continuityUnknownLogicalEntityIds: sortedUniqueStrings(value.continuityUnknownLogicalEntityIds || [], "logicalLineageState.continuityUnknownLogicalEntityIds"),
    continuityGenerationByLogicalEntityId,
  };
  return normalized;
}

function evidenceId(file) {
  return identity("evidence", { kind: "file-content", path: file.path, digest: file.digest });
}

function originalNodeMetadata({ evidenceIds = [], sourceSnapshotId = null, authorityClass = "derived", origin = "derived-source-scan", confidence, freshness = "current", producer = PRODUCER } = {}) {
  const metadata = {
    authorityClass,
    origin,
    evidenceIds: sortedUniqueStrings(evidenceIds, "evidenceIds"),
    freshness,
    producer,
    producerVersion: TEMPORAL_PROVENANCE_VERSION,
    instructionAuthority: false,
    promotionAuthority: false,
  };
  if (sourceSnapshotId) metadata.sourceSnapshotId = sourceSnapshotId;
  if (confidence != null) metadata.confidence = confidence;
  return metadata;
}

function originalEdgeRecord({ type, from, to, sourceSnapshotId, evidenceIds = [], origin = "derived-source-scan", authorityClass = "derived", confidence, freshness = "current", producer = PRODUCER }) {
  const payload = {
    type,
    from,
    to,
    authorityClass,
    origin,
    evidenceIds: sortedUniqueStrings(evidenceIds, "edge evidenceIds"),
    freshness,
    sourceSnapshotId,
    producer,
    producerVersion: TEMPORAL_PROVENANCE_VERSION,
    instructionAuthority: false,
    promotionAuthority: false,
  };
  if (confidence != null) payload.confidence = confidence;
  return { edgeId: identity("temporal-edge", payload), ...payload };
}

function temporalRecordFactories(storage) {
  const producer = formatForVerifiedOwner(storage).protocol(PRODUCER);
  return {
    nodeMetadata: (input = {}) => originalNodeMetadata({ ...input, producer }),
    edgeRecord: (input) => originalEdgeRecord({ ...input, producer }),
  };
}

function parentIdsFor(revisionParentIds, logicalEntityId, prefix) {
  const values = revisionParentIds[logicalEntityId] || [];
  for (const value of values) {
    if (!new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(value)) {
      fail(`Revision parent ${value} does not match ${prefix}.`, "INVALID_REVISION_PARENT");
    }
  }
  return values;
}

function revisionReferenceKind(revisionId) {
  if (revisionId.startsWith("file-revision-")) return "FileRevision";
  if (revisionId.startsWith("symbol-revision-")) return "SymbolRevision";
  if (revisionId.startsWith("test-revision-")) return "TestRevision";
  for (const [kind, definition] of Object.entries(PRODUCT_DEFINITIONS)) {
    if (revisionId.startsWith(`${definition.revisionPrefix}-`)) return `${kind}Revision`;
  }
  return "";
}

function temporalLogicalEntityDescriptors({ projectId, files, productModel }) {
  const orderedFiles = [...files].sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const logicalEntityIds = new Set();
  const fileDescriptors = orderedFiles.map((file) => {
    if (!file || typeof file.path !== "string" || !file.path || !/^[a-f0-9]{64}$/.test(file.digest || "")) {
      fail("Every temporal file requires a path and SHA-256 digest.", "INVALID_TEMPORAL_FILE");
    }
    const fileId = identity("file", { projectId, path: file.path });
    logicalEntityIds.add(fileId);
    const symbols = [...(file.symbols || [])].sort((left, right) => Number(left.line || 0) - Number(right.line || 0)
      || String(left.kind).localeCompare(String(right.kind)) || String(left.name).localeCompare(String(right.name)));
    const qualifiedCounts = new Map();
    const declarationCounts = new Map();
    for (const symbol of symbols) {
      const qualifiedName = symbol.qualifiedName || symbol.name || "";
      const qualifiedKey = `${symbol.kind || "symbol"}:${qualifiedName}`;
      const declarationKey = `${qualifiedKey}:${symbol.signature || ""}`;
      qualifiedCounts.set(qualifiedKey, (qualifiedCounts.get(qualifiedKey) || 0) + 1);
      declarationCounts.set(declarationKey, (declarationCounts.get(declarationKey) || 0) + 1);
    }
    const occurrences = new Map();
    const symbolDescriptors = symbols.map((symbol) => {
      const qualifiedName = symbol.qualifiedName || symbol.name || "";
      const scopePath = symbol.scopePath || "";
      const signature = symbol.signature || `${symbol.kind || "symbol"} ${symbol.name || ""}`;
      const qualifiedKey = `${symbol.kind || "symbol"}:${qualifiedName}`;
      const declarationKey = `${qualifiedKey}:${signature}`;
      const occurrence = (occurrences.get(declarationKey) || 0) + 1;
      occurrences.set(declarationKey, occurrence);
      const overloaded = qualifiedCounts.get(qualifiedKey) > 1;
      const identityAmbiguous = Boolean(symbol.identityAmbiguous) || declarationCounts.get(declarationKey) > 1;
      const identitySignature = overloaded ? signature : "";
      const identityOccurrence = identityAmbiguous ? occurrence : 1;
      const symbolId = identity("symbol", {
        fileId,
        symbolKind: symbol.kind || "symbol",
        qualifiedName,
        signature: identitySignature,
        occurrence: identityOccurrence,
      });
      logicalEntityIds.add(symbolId);
      return {
        symbolId,
        name: symbol.name || "",
        symbolKind: symbol.kind || "symbol",
        occurrence,
        line: Number(symbol.line || 1),
        endLine: Number(symbol.endLine || symbol.line || 1),
        scopePath,
        qualifiedName,
        signature,
        identityAmbiguous,
        identitySignature,
        identityOccurrence,
      };
    });
    const testId = file.classification === "test" ? identity("test", { projectId, path: file.path }) : null;
    if (testId) logicalEntityIds.add(testId);
    return { file, fileId, symbolDescriptors, testId };
  });

  if (!productModel || typeof productModel !== "object" || Array.isArray(productModel)) fail("productModel is required.", "INVALID_TEMPORAL_PRODUCT_MODEL");
  if (!/^product-model-[a-f0-9]{24}$/.test(productModel.productModelId || "") || !/^[a-f0-9]{64}$/.test(productModel.productModelHash || "")) {
    fail("productModel requires verified content-derived identity.", "INVALID_TEMPORAL_PRODUCT_MODEL");
  }
  const productDescriptors = [];
  for (const [kind, definition] of Object.entries(PRODUCT_DEFINITIONS)) {
    const entities = productModel[definition.collection] || (kind === "Policy" && productModel.schemaVersion === 1 ? [] : null);
    if (!Array.isArray(entities)) fail(`productModel.${definition.collection} must be an array.`, "INVALID_TEMPORAL_PRODUCT_MODEL");
    for (const entity of entities) {
      if (!entity || typeof entity.key !== "string" || !entity.key) fail(`${kind} requires a stable key.`, "INVALID_TEMPORAL_PRODUCT_MODEL");
      const logicalEntityId = identity(definition.prefix, { projectId, key: entity.key });
      logicalEntityIds.add(logicalEntityId);
      productDescriptors.push({ kind, definition, entity, logicalEntityId });
    }
  }
  productDescriptors.sort((left, right) => left.logicalEntityId.localeCompare(right.logicalEntityId));
  return {
    fileDescriptors,
    productDescriptors,
    logicalEntityIds: [...logicalEntityIds].sort(),
  };
}

export function currentTemporalLogicalEntityIds({ projectId, files, productModel = null } = {}) {
  if (typeof projectId !== "string" || !projectId.trim()) fail("projectId is required.", "TEMPORAL_PROJECT_ID_REQUIRED");
  if (!Array.isArray(files)) fail("files must be an array.", "TEMPORAL_FILES_REQUIRED");
  const selectedProductModel = productModel || normalizeProductModelDocument(emptyProductModelDocument());
  return temporalLogicalEntityDescriptors({ projectId, files, productModel: selectedProductModel }).logicalEntityIds;
}

const CURRENT_LOGICAL_NODE_KINDS = new Set(["File", "Symbol", "Test", ...Object.keys(PRODUCT_DEFINITIONS)]);

export function deriveIncrementalLogicalLineageState({ previousGraph = null, currentLogicalEntityIds = [], previousStateUnavailable = false } = {}) {
  const current = new Set(sortedUniqueStrings(currentLogicalEntityIds, "currentLogicalEntityIds"));
  if (!previousGraph) return normalizeLogicalLineageState({
    continuityUnknownLogicalEntityIds: previousStateUnavailable ? [...current] : [],
  });
  const previous = normalizeLogicalLineageState(previousGraph.logicalLineageState || {});
  const previousUnknown = new Set(previous.continuityUnknownLogicalEntityIds);
  const previousCurrent = new Set((previousGraph.nodes || [])
    .filter((node) => CURRENT_LOGICAL_NODE_KINDS.has(node.kind))
    .map((node) => node.nodeId));
  const retired = new Set(previous.retiredLogicalEntityIds);
  for (const logicalEntityId of previousCurrent) if (!current.has(logicalEntityId)) retired.add(logicalEntityId);
  const generations = new Map(Object.entries(previous.continuityGenerationByLogicalEntityId));
  // Graphs written before continuity generations already recorded restored
  // entities in the discontinuity set. Preserve that evidence as generation 1.
  for (const logicalEntityId of previous.discontinuousLogicalEntityIds) {
    if (!generations.has(logicalEntityId)) generations.set(logicalEntityId, 1);
  }
  for (const logicalEntityId of current) {
    if (retired.has(logicalEntityId) && !previousCurrent.has(logicalEntityId) && !previousUnknown.has(logicalEntityId)) {
      generations.set(logicalEntityId, (generations.get(logicalEntityId) || 0) + 1);
    }
  }
  const discontinuous = new Set([...current].filter((logicalEntityId) => (generations.get(logicalEntityId) || 0) > 0));
  const continuityUnknown = new Set(previousUnknown);
  if (previousStateUnavailable) for (const logicalEntityId of current) continuityUnknown.add(logicalEntityId);
  return normalizeLogicalLineageState({
    discontinuousLogicalEntityIds: [...discontinuous],
    retiredLogicalEntityIds: [...retired],
    continuityUnknownLogicalEntityIds: [...continuityUnknown],
    continuityGenerationByLogicalEntityId: Object.fromEntries([...generations.entries()].filter(([, generation]) => generation > 0)),
  });
}

export function filterLogicalLineageStateForCurrentTemporalEntities({ projectId, files, productModel = null, logicalLineageState = {} } = {}) {
  const current = new Set(currentTemporalLogicalEntityIds({ projectId, files, productModel }));
  const normalized = normalizeLogicalLineageState(logicalLineageState);
  return normalizeLogicalLineageState({
    discontinuousLogicalEntityIds: normalized.discontinuousLogicalEntityIds.filter((logicalEntityId) => current.has(logicalEntityId)),
    retiredLogicalEntityIds: normalized.retiredLogicalEntityIds,
    continuityUnknownLogicalEntityIds: normalized.continuityUnknownLogicalEntityIds
      .filter((logicalEntityId) => current.has(logicalEntityId) || normalized.retiredLogicalEntityIds.includes(logicalEntityId)),
    continuityGenerationByLogicalEntityId: Object.fromEntries(Object.entries(normalized.continuityGenerationByLogicalEntityId)
      .filter(([logicalEntityId]) => current.has(logicalEntityId) || normalized.retiredLogicalEntityIds.includes(logicalEntityId))),
  });
}

// Incremental preview helper only: the normal graph builder intentionally keeps
// rejecting unknown caller-supplied parent keys.
export function filterRevisionParentsForCurrentTemporalEntities({ projectId, files, productModel = null, revisionParentIds = {} } = {}) {
  const currentIds = new Set(currentTemporalLogicalEntityIds({ projectId, files, productModel }));
  const revisionParents = normalizeRevisionParentIds(revisionParentIds);
  return Object.fromEntries(Object.entries(revisionParents).filter(([logicalEntityId]) => currentIds.has(logicalEntityId)));
}

function productRecordsFor({ productDescriptors, productEvidenceId, revisionParents }) {
  if (typeof productEvidenceId !== "string" || !productEvidenceId) fail("productEvidenceId is required.", "INVALID_TEMPORAL_PRODUCT_MODEL");
  return productDescriptors.map(({ kind, definition, entity, logicalEntityId }) => {
    const parentRevisionIds = parentIdsFor(revisionParents, logicalEntityId, definition.revisionPrefix);
    const semantic = canonical(entity);
    const revisionId = identity(definition.revisionPrefix, { logicalEntityId, semantic, parentRevisionIds });
    return {
      kind,
      revisionKind: `${kind}Revision`,
      key: entity.key,
      logicalEntityId,
      revisionId,
      parentRevisionIds,
      semantic,
      evidenceIds: [productEvidenceId],
    };
  });
}

function onboardingProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided",
    projectionInputId: null,
    projectionInputHash: null,
    candidateSetIds: [],
    reviewDecisionIds: [],
    productModelRevisionIds: [],
    historicalCoverage: null,
  };
  const historical = projection.historicalCoverage;
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    candidateSetIds: projection.candidateSets.map((item) => item.candidateSetId),
    reviewDecisionIds: projection.reviewDecisions.map((item) => item.reviewDecisionId),
    productModelRevisionIds: projection.productModelRevisions.map((item) => item.productModelId),
    historicalCoverage: historical ? {
      boundaryId: historical.boundaryId,
      boundaryHash: historical.boundaryHash,
      opaqueCandidateSetIds: historical.opaqueCandidateSetIds,
      opaqueReviewDecisionIds: historical.opaqueReviewDecisionIds,
      typedRevisionIds: historical.typedRevisionIds,
      opaqueRevisionIds: historical.opaqueRevisionIds,
      legacyWorldEmbeddingReferenceIds: historical.legacyWorldEmbeddingReferenceIds,
      continuityReceiptIds: historical.continuityReceipts.map((receipt) => receipt.receiptId),
    } : null,
  };
}

function productPolicyProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided",
    projectionInputId: null,
    projectionInputHash: null,
    candidateIds: [],
    reviewDecisionIds: [],
  };
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    candidateIds: projection.candidates.map((entry) => entry.candidate.candidateId),
    reviewDecisionIds: projection.reviewDecisions.map((review) => review.reviewDecisionId),
  };
}

function verifyProductPolicyProjectionInput(projection, projectId) {
  if (!projection || projection.kind !== "ProductPolicyGraphProjectionInput"
    || !familyFormatForOriginal("head-agent-core-product-policy-graph-projection", projection)
    || projection.protocol.version !== "0.1.0" || projection.projectId !== projectId
    || !/^product-model-[a-f0-9]{24}$/.test(projection.currentProductModelId || "")
    || !Array.isArray(projection.candidates) || !Array.isArray(projection.reviewDecisions)
    || projection.authority !== "derived-projection-input-not-product-canon"
    || projection.instructionAuthority !== false || projection.promotionAuthority !== false || projection.recoveryAuthority !== false) {
    fail("Product Policy projection input is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  }
  verifyArtifactAuthorityBoundary("GraphSnapshot", projection.authorityBoundary);
  const payload = { ...projection };
  delete payload.projectionInputId;
  delete payload.projectionInputHash;
  const hash = digest(canonicalJson(payload));
  if (projection.projectionInputHash !== hash || projection.projectionInputId !== `product-policy-projection-${hash.slice(0, 24)}`) {
    fail("Product Policy projection input digest is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  }
  const candidateIds = projection.candidates.map((entry) => entry?.candidate?.candidateId);
  const reviewIds = projection.reviewDecisions.map((review) => review?.reviewDecisionId);
  if (candidateIds.some((id) => !/^policy-candidate-[a-f0-9]{24}$/.test(id || "")) || new Set(candidateIds).size !== candidateIds.length
    || reviewIds.some((id) => !/^review-decision-[a-f0-9]{24}$/.test(id || "")) || new Set(reviewIds).size !== reviewIds.length) {
    fail("Product Policy projection identities are invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  }
  const candidateById = new Map(projection.candidates.map((entry) => [entry.candidate.candidateId, entry]));
  for (const review of projection.reviewDecisions) {
    const entry = candidateById.get(review.candidateId);
    if (!entry || entry.reviewDecisionId !== review.reviewDecisionId || review.candidateHash !== entry.candidate.candidateHash
      || review.projectId !== projectId || !["accept", "reject"].includes(review.disposition)) {
      fail("Product Policy projection ReviewDecision binding is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
    }
  }
  return projection;
}

function appendOnboardingProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const emptySummary = {
    onboardingCandidateSetCount: 0,
    onboardingCandidateCount: 0,
    onboardingEvidenceCount: 0,
    onboardingUnknownCount: 0,
    onboardingReviewDecisionCount: 0,
    onboardingAcceptedCandidateCount: 0,
    onboardingRejectedCandidateCount: 0,
    productModelRevisionReceiptCount: 0,
    historicalOnboardingReferenceCount: 0,
    historicalContinuityCount: 0,
  };
  if (!projection) return emptySummary;
  verifyOnboardingGraphProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => {
    const existing = nodeById.get(node.nodeId);
    if (existing) return existing;
    nodeById.set(node.nodeId, node);
    nodes.push(node);
    return node;
  };
  const candidateById = new Map();
  const conceptReferences = new Map();

  const historicalCoverage = projection.historicalCoverage;
  if (historicalCoverage) {
    const referenceById = new Map(historicalCoverage.references
      .filter((reference) => reference.role === "historical-candidate-set")
      .map((reference) => [reference.artifactId, reference]));
    const receiptsByHistoricalId = new Map();
    for (const receipt of historicalCoverage.continuityReceipts) {
      const receipts = receiptsByHistoricalId.get(receipt.historicalCandidateSetId) || [];
      receipts.push(receipt.receiptId);
      receiptsByHistoricalId.set(receipt.historicalCandidateSetId, receipts);
    }
    for (const historicalCandidateSetId of historicalCoverage.opaqueCandidateSetIds) {
      const reference = referenceById.get(historicalCandidateSetId);
      pushNode({
        nodeId: historicalCandidateSetId,
        kind: "HistoricalOnboardingCandidateReference",
        projectId,
        boundaryId: historicalCoverage.boundaryId,
        referencedCandidateSetId: historicalCandidateSetId,
        artifactSha256: reference.sha256,
        continuityReceiptIds: [...(receiptsByHistoricalId.get(historicalCandidateSetId) || [])].sort(),
        ...nodeMetadata({ evidenceIds: [historicalCoverage.boundaryId, reference.sha256], sourceSnapshotId,
          origin: "historical-onboarding-opaque-reference", freshness: "historical" }),
      });
    }
    for (const receipt of historicalCoverage.continuityReceipts) edges.push(edgeRecord({
      type: "HISTORICALLY_FOLLOWS",
      from: receipt.historicalCandidateSetId,
      to: receipt.currentCandidateSetId,
      sourceSnapshotId,
      evidenceIds: [receipt.receiptId, receipt.receiptHash],
      origin: "historical-onboarding-continuity",
      authorityClass: "derived",
      freshness: "historical",
    }));
  }

  const ensureSourceReference = (referencedSourceSnapshotId, evidenceIds) => {
    if (referencedSourceSnapshotId === sourceSnapshotId) return sourceSnapshotId;
    pushNode({
      nodeId: referencedSourceSnapshotId,
      kind: "SourceSnapshotReference",
      referencedSourceSnapshotId,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "onboarding-source-reference" }),
    });
    return referencedSourceSnapshotId;
  };

  for (const candidateSet of projection.candidateSets) {
    const setEvidenceIds = candidateSet.evidence.map((evidence) => evidence.evidenceId);
    const setEvidenceId = identity("evidence", {
      kind: "onboarding-candidate-set",
      candidateSetId: candidateSet.candidateSetId,
      candidateSetHash: candidateSet.candidateSetHash,
    });
    const sourceReferenceId = ensureSourceReference(candidateSet.sourceSnapshotId, [setEvidenceId]);
    pushNode({
      nodeId: candidateSet.candidateSetId,
      kind: "OnboardingCandidateSet",
      projectId,
      sessionId: candidateSet.sessionId,
      candidateSetHash: candidateSet.candidateSetHash,
      inputMode: candidateSet.inputMode,
      evidenceWorldModelId: candidateSet.worldModelId || null,
      evidenceSourceSnapshotId: candidateSet.sourceSnapshotId,
      evidenceProductModelId: candidateSet.productModelId,
      candidateIds: candidateSet.candidates.map((candidate) => candidate.candidateId),
      onboardingEvidenceIds: setEvidenceIds,
      unknownIds: candidateSet.unknowns.map((unknown) => unknown.unknownId),
      parentCandidateSetIds: candidateSet.parentCandidateSetIds,
      producerReviewDecisionId: onboardingCandidateProducerReviewDecisionId(candidateSet),
      ...nodeMetadata({ evidenceIds: [...setEvidenceIds, setEvidenceId], sourceSnapshotId, origin: "onboarding-candidate-set" }),
    });
    edges.push(edgeRecord({
      type: "PROPOSES_FROM",
      from: candidateSet.candidateSetId,
      to: sourceReferenceId,
      sourceSnapshotId,
      evidenceIds: [setEvidenceId],
      origin: "onboarding-candidate-source",
    }));
    for (const evidence of candidateSet.evidence) {
      pushNode({
        nodeId: evidence.evidenceId,
        kind: "OnboardingEvidence",
        onboardingEvidenceHash: evidence.evidenceHash,
        sourceKind: evidence.sourceKind,
        sourceId: evidence.sourceId,
        path: evidence.path,
        line: evidence.line,
        contentDigest: evidence.contentDigest,
        statement: evidence.statement,
        ...nodeMetadata({ evidenceIds: [evidence.evidenceId], sourceSnapshotId, origin: `onboarding-evidence:${evidence.sourceKind}` }),
      });
      edges.push(edgeRecord({
        type: "CONTAINS",
        from: candidateSet.candidateSetId,
        to: evidence.evidenceId,
        sourceSnapshotId,
        evidenceIds: [evidence.evidenceId],
        origin: "onboarding-candidate-set",
      }));
    }
    for (const candidate of candidateSet.candidates) {
      candidateById.set(candidate.candidateId, { candidate, candidateSet });
      pushNode({
        nodeId: candidate.candidateId,
        kind: "OnboardingProductCandidate",
        candidateHash: candidate.candidateHash,
        productKind: candidate.productKind,
        proposedEntity: candidate.proposedEntity,
        explanation: candidate.explanation,
        evidenceSourceSnapshotId: candidate.sourceSnapshotId,
        ...nodeMetadata({
          evidenceIds: candidate.evidenceIds,
          sourceSnapshotId,
          authorityClass: "heuristic",
          origin: candidate.origin,
          confidence: candidate.confidence,
        }),
      });
      edges.push(edgeRecord({
        type: "CONTAINS",
        from: candidateSet.candidateSetId,
        to: candidate.candidateId,
        sourceSnapshotId,
        evidenceIds: candidate.evidenceIds,
        origin: "onboarding-candidate-set",
      }));
      const conceptReferenceId = identity("product-concept-reference", {
        projectId,
        productKind: candidate.productKind,
        key: candidate.proposedEntity.key,
      });
      const concept = conceptReferences.get(conceptReferenceId) || {
        productKind: candidate.productKind,
        key: candidate.proposedEntity.key,
        evidenceIds: new Set(),
      };
      for (const evidenceId of candidate.evidenceIds) concept.evidenceIds.add(evidenceId);
      conceptReferences.set(conceptReferenceId, concept);
      edges.push(edgeRecord({
        type: "PROPOSES_TO",
        from: candidate.candidateId,
        to: conceptReferenceId,
        sourceSnapshotId,
        evidenceIds: candidate.evidenceIds,
        origin: candidate.origin,
        authorityClass: "heuristic",
        confidence: candidate.confidence,
      }));
      for (const evidenceId of candidate.evidenceIds) edges.push(edgeRecord({
        type: "SUPPORTED_BY",
        from: candidate.candidateId,
        to: evidenceId,
        sourceSnapshotId,
        evidenceIds: [evidenceId],
        origin: candidate.origin,
        authorityClass: "heuristic",
        confidence: candidate.confidence,
      }));
    }
    for (const unknown of candidateSet.unknowns) {
      pushNode({
        nodeId: unknown.unknownId,
        kind: "OnboardingUnknown",
        statement: unknown.statement,
        unknownStatus: unknown.status,
        ...nodeMetadata({ evidenceIds: unknown.evidenceIds || [], sourceSnapshotId, origin: "onboarding-explicit-unknown" }),
      });
      edges.push(edgeRecord({
        type: "CONTAINS",
        from: candidateSet.candidateSetId,
        to: unknown.unknownId,
        sourceSnapshotId,
        evidenceIds: unknown.evidenceIds || [],
        origin: "onboarding-candidate-set",
      }));
    }
  }

  for (const [conceptReferenceId, concept] of conceptReferences) pushNode({
    nodeId: conceptReferenceId,
    kind: "ProductConceptReference",
    projectId,
    productKind: concept.productKind,
    key: concept.key,
    ...nodeMetadata({ evidenceIds: [...concept.evidenceIds], sourceSnapshotId, origin: "onboarding-candidate-target" }),
  });

  for (const candidateSet of projection.candidateSets) for (const parentCandidateSetId of candidateSet.parentCandidateSetIds) {
    edges.push(edgeRecord({
      type: "PARENT_OF",
      from: parentCandidateSetId,
      to: candidateSet.candidateSetId,
      sourceSnapshotId,
      evidenceIds: [identity("evidence", { kind: "onboarding-candidate-parent", parentCandidateSetId, candidateSetId: candidateSet.candidateSetId })],
      origin: "onboarding-review-revision",
      authorityClass: "reviewed",
    }));
  }

  for (const candidateSet of projection.candidateSets) {
    const producerReviewDecisionId = onboardingCandidateProducerReviewDecisionId(candidateSet);
    if (!producerReviewDecisionId) continue;
    const producerReview = projection.reviewDecisions.find((review) => review.reviewDecisionId === producerReviewDecisionId);
    const producerReviewEvidenceId = identity("evidence", {
      kind: "onboarding-review-decision",
      reviewDecisionId: producerReview.reviewDecisionId,
      reviewDecisionHash: producerReview.reviewDecisionHash,
    });
    const successorEvidenceId = identity("evidence", {
      kind: "onboarding-candidate-set",
      candidateSetId: candidateSet.candidateSetId,
      candidateSetHash: candidateSet.candidateSetHash,
    });
    edges.push(edgeRecord({
      type: "PRODUCES",
      from: producerReviewDecisionId,
      to: candidateSet.candidateSetId,
      sourceSnapshotId,
      evidenceIds: [producerReviewEvidenceId, successorEvidenceId],
      origin: "onboarding-review-revision",
      authorityClass: "reviewed",
    }));
  }

  for (const revision of projection.productModelRevisions) {
    const model = normalizeProductModelDocument(revision.document);
    pushNode({
      nodeId: revision.productModelId,
      kind: "ProductModelRevision",
      productModelHash: revision.productModelHash,
      entityCounts: {
        featureGroups: model.featureGroups.length,
        capabilities: model.capabilities.length,
        features: model.features.length,
        requirements: model.requirements.length,
        constraints: model.constraints.length,
        decisions: model.decisions.length,
        policies: model.policies?.length || 0,
      },
      ...nodeMetadata({
        evidenceIds: [identity("evidence", { kind: "product-model-revision", productModelId: revision.productModelId, productModelHash: revision.productModelHash })],
        sourceSnapshotId,
        authorityClass: "canon-projected",
        origin: "user-owned-product-canon-revision",
      }),
    });
  }

  for (const review of projection.reviewDecisions) {
    const reviewEvidenceId = identity("evidence", {
      kind: "onboarding-review-decision",
      reviewDecisionId: review.reviewDecisionId,
      reviewDecisionHash: review.reviewDecisionHash,
    });
    pushNode({
      nodeId: review.reviewDecisionId,
      kind: "OnboardingReviewDecision",
      projectId,
      sessionId: review.sessionId,
      reviewDecisionHash: review.reviewDecisionHash,
      candidateSetId: review.candidateSetId,
      disposition: review.disposition,
      acceptedCandidateIds: review.acceptedCandidateIds,
      rejectedCandidateIds: review.rejectedCandidateIds,
      previousProductModelId: review.previousProductModelId,
      previousProductModelHash: review.previousProductModelHash,
      resultingProductModelId: review.resultingProductModelId,
      resultingProductModelHash: review.resultingProductModelHash,
      rationale: review.rationale,
      sourceAuthority: review.authority,
      sourcePromotionAuthority: review.promotionAuthority,
      ...nodeMetadata({ evidenceIds: [reviewEvidenceId], sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-onboarding-review" }),
    });
    edges.push(edgeRecord({
      type: "REVIEWED_BY",
      from: review.candidateSetId,
      to: review.reviewDecisionId,
      sourceSnapshotId,
      evidenceIds: [reviewEvidenceId],
      origin: "explicit-user-onboarding-review",
      authorityClass: "reviewed",
    }));
    for (const candidateId of review.acceptedCandidateIds) edges.push(edgeRecord({
      type: "ACCEPTED_BY",
      from: candidateId,
      to: review.reviewDecisionId,
      sourceSnapshotId,
      evidenceIds: [reviewEvidenceId],
      origin: "explicit-user-onboarding-review",
      authorityClass: "reviewed",
    }));
    for (const candidateId of review.rejectedCandidateIds) edges.push(edgeRecord({
      type: "REJECTED_BY",
      from: candidateId,
      to: review.reviewDecisionId,
      sourceSnapshotId,
      evidenceIds: [reviewEvidenceId],
      origin: "explicit-user-onboarding-review",
      authorityClass: "reviewed",
    }));
    if (review.promotionAuthority) {
      edges.push(edgeRecord({
        type: "PRODUCES",
        from: review.reviewDecisionId,
        to: review.resultingProductModelId,
        sourceSnapshotId,
        evidenceIds: [reviewEvidenceId],
        origin: "explicit-user-onboarding-review",
        authorityClass: "reviewed",
      }));
      if (review.previousProductModelId !== review.resultingProductModelId) edges.push(edgeRecord({
        type: "PARENT_OF",
        from: review.previousProductModelId,
        to: review.resultingProductModelId,
        sourceSnapshotId,
        evidenceIds: [reviewEvidenceId],
        origin: "explicit-user-onboarding-review",
        authorityClass: "reviewed",
      }));
      for (const candidateId of review.acceptedCandidateIds) edges.push(edgeRecord({
        type: "PROMOTED_FROM",
        from: review.resultingProductModelId,
        to: candidateId,
        sourceSnapshotId,
        evidenceIds: [reviewEvidenceId, ...(candidateById.get(candidateId)?.candidate.evidenceIds || [])],
        origin: "explicit-user-onboarding-review",
        authorityClass: "reviewed",
      }));
    }
  }

  return {
    onboardingCandidateSetCount: projection.candidateSets.length,
    onboardingCandidateCount: new Set(projection.candidateSets.flatMap((item) => item.candidates.map((candidate) => candidate.candidateId))).size,
    onboardingEvidenceCount: new Set(projection.candidateSets.flatMap((item) => item.evidence.map((evidence) => evidence.evidenceId))).size,
    onboardingUnknownCount: new Set(projection.candidateSets.flatMap((item) => item.unknowns.map((unknown) => unknown.unknownId))).size,
    onboardingReviewDecisionCount: projection.reviewDecisions.length,
    onboardingAcceptedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.acceptedCandidateIds.length, 0),
    onboardingRejectedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.rejectedCandidateIds.length, 0),
    productModelRevisionReceiptCount: projection.productModelRevisions.length,
    historicalOnboardingReferenceCount: projection.historicalCoverage?.opaqueCandidateSetIds.length || 0,
    historicalContinuityCount: projection.historicalCoverage?.continuityReceipts.length || 0,
  };
}

function appendProductPolicyProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const empty = { productPolicyCandidateCount: 0, productPolicyEvidenceCount: 0, productPolicyReviewDecisionCount: 0, appliedProductPolicyDecisionCount: 0 };
  if (!projection) return empty;
  verifyProductPolicyProjectionInput(projection, projectId);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => {
    const existing = nodeById.get(node.nodeId);
    if (existing) return existing;
    nodeById.set(node.nodeId, node);
    nodes.push(node);
    return node;
  };
  const add = (type, from, to, evidenceIds, authorityClass = "derived") => edges.push(edgeRecord({
    type, from, to, sourceSnapshotId, evidenceIds: [...new Set(evidenceIds)].sort(),
    origin: "product-policy-lineage-projection", authorityClass, freshness: "historical",
  }));
  const modelReference = (productModelId, productModelHash, evidenceIds) => {
    const nodeId = identity("product-model-revision-reference", { projectId, productModelId, productModelHash });
    pushNode({
      nodeId,
      kind: "ProductModelRevisionReference",
      projectId,
      referencedProductModelId: productModelId,
      referencedProductModelHash: productModelHash,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "product-policy-model-revision-reference", freshness: "historical" }),
    });
    return nodeId;
  };
  const reviewById = new Map(projection.reviewDecisions.map((review) => [review.reviewDecisionId, review]));
  const policyRevisionByKeyAndSemanticHash = new Map(nodes.filter((node) => node.kind === "PolicyRevision")
    .map((node) => [`${node.key}:${digest(canonicalJson(node.semantic))}`, node]));
  let evidenceCount = 0;
  let appliedCount = 0;
  for (const entry of projection.candidates) {
    const candidate = entry.candidate;
    const candidateEvidence = [candidate.candidateId, ...candidate.evidenceAnchors.map((anchor) => anchor.digest).filter(Boolean)];
    const proposedPolicyHash = digest(canonicalJson(candidate.proposedPolicy));
    const baseReferenceId = modelReference(candidate.baseProductModelId, candidate.baseProductModelHash, candidateEvidence);
    const resultReferenceId = modelReference(candidate.resultingProductModelId, candidate.resultingProductModelHash, candidateEvidence);
    const evidenceIds = candidate.evidenceAnchors.map((anchor) => identity("product-policy-evidence", { candidateId: candidate.candidateId, anchor }));
    pushNode({
      nodeId: candidate.candidateId,
      kind: "ProductPolicyCandidate",
      projectId,
      candidateHash: candidate.candidateHash,
      operation: candidate.operation,
      policyKey: candidate.policyKey,
      baseProductModelId: candidate.baseProductModelId,
      baseProductModelHash: candidate.baseProductModelHash,
      resultingProductModelId: candidate.resultingProductModelId,
      resultingProductModelHash: candidate.resultingProductModelHash,
      proposedPolicyHash,
      evidenceStatus: candidate.evidenceStatus,
      evidenceNodeIds: evidenceIds,
      reviewDecisionId: entry.reviewDecisionId,
      applicationStatus: entry.applicationStatus,
      sourceAuthority: candidate.authority,
      ...nodeMetadata({ evidenceIds: candidateEvidence, sourceSnapshotId, origin: "product-policy-candidate", freshness: "historical" }),
    });
    add("PROPOSES_FROM", candidate.candidateId, baseReferenceId, candidateEvidence);
    add("PROPOSES_TO", candidate.candidateId, resultReferenceId, candidateEvidence);
    candidate.evidenceAnchors.forEach((anchor, index) => {
      const evidenceNodeId = evidenceIds[index];
      pushNode({
        nodeId: evidenceNodeId,
        kind: "ProductPolicyEvidence",
        projectId,
        candidateId: candidate.candidateId,
        evidenceKind: anchor.kind,
        reference: anchor.reference,
        contentDigest: anchor.digest,
        summary: anchor.summary,
        ...nodeMetadata({ evidenceIds: [evidenceNodeId, ...(anchor.digest ? [anchor.digest] : [])], sourceSnapshotId, origin: "product-policy-evidence", freshness: "historical" }),
      });
      add("SUPPORTED_BY", candidate.candidateId, evidenceNodeId, [evidenceNodeId]);
      evidenceCount += 1;
    });
    if (!entry.reviewDecisionId) continue;
    const review = reviewById.get(entry.reviewDecisionId);
    pushNode({
      nodeId: review.reviewDecisionId,
      kind: "ProductPolicyReviewDecision",
      projectId,
      reviewDecisionHash: review.reviewDecisionHash,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      disposition: review.disposition,
      rationale: review.rationale,
      resultingProductModelId: review.resultingProductModelId,
      applicationStatus: entry.applicationStatus,
      sourceAuthority: review.authority,
      sourcePromotionAuthority: review.promotionAuthority,
      ...nodeMetadata({ evidenceIds: [candidate.candidateId, review.reviewDecisionId], sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-product-policy-review", freshness: "historical" }),
    });
    add("REVIEWED_BY", candidate.candidateId, review.reviewDecisionId, [candidate.candidateId, review.reviewDecisionId], "reviewed");
    add(review.disposition === "accept" ? "ACCEPTED_BY" : "REJECTED_BY", candidate.candidateId, review.reviewDecisionId, [candidate.candidateId, review.reviewDecisionId], "reviewed");
    if (review.disposition === "accept" && entry.applicationStatus.startsWith("applied-")) {
      add("PRODUCES", review.reviewDecisionId, resultReferenceId, [candidate.candidateId, review.reviewDecisionId], "reviewed");
      appliedCount += 1;
      const policyRevision = policyRevisionByKeyAndSemanticHash.get(`${candidate.policyKey}:${proposedPolicyHash}`) || null;
      if (entry.applicationStatus === "applied-current" && !policyRevision) fail("Current accepted Product Policy has no exact PolicyRevision.", "PRODUCT_POLICY_TEMPORAL_REVISION_MISSING");
      if (policyRevision) {
        add("REFERENCES", resultReferenceId, policyRevision.nodeId, [candidate.candidateId, review.reviewDecisionId], "reviewed");
        add("PRODUCES", review.reviewDecisionId, policyRevision.nodeId, [candidate.candidateId, review.reviewDecisionId], "reviewed");
      }
    }
  }
  return {
    productPolicyCandidateCount: projection.candidates.length,
    productPolicyEvidenceCount: evidenceCount,
    productPolicyReviewDecisionCount: projection.reviewDecisions.length,
    appliedProductPolicyDecisionCount: appliedCount,
  };
}

function featureMappingProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided",
    projectionInputId: null,
    projectionInputHash: null,
    candidateSetIds: [],
    reviewDecisionIds: [],
  };
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    candidateSetIds: projection.candidateSets.map((item) => item.candidateSetId),
    reviewDecisionIds: projection.reviewDecisions.map((item) => item.reviewDecisionId),
  };
}

function reviewedRelationshipIdentityPayload({ review, candidate }) {
  return {
    projectId: review.projectId,
    reviewDecisionId: review.reviewDecisionId,
    candidateId: candidate.candidateId,
    relationshipType: candidate.relationshipType,
    fromNodeId: candidate.from.nodeId,
    fromKind: candidate.from.kind,
    toNodeId: candidate.to.nodeId,
    toKind: candidate.to.kind,
    evidenceSourceSnapshotId: candidate.sourceSnapshotId,
    productModelId: review.productModelId,
  };
}

function appendFeatureMappingProjection({
  projectId, sourceSnapshotId, projection, nodes, edges, storage,
  continuityGenerationByLogicalEntityId = {}, continuityUnknownLogicalEntityIds = new Set(),
}) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const emptySummary = {
    featureMappingCandidateSetCount: 0,
    featureMappingCandidateCount: 0,
    featureMappingEvidenceCount: 0,
    featureMappingUnknownCount: 0,
    featureMappingReviewDecisionCount: 0,
    featureMappingAcceptedCandidateCount: 0,
    featureMappingRejectedCandidateCount: 0,
    reviewedRelationshipCount: 0,
    activeReviewedRelationshipCount: 0,
  };
  if (!projection) return emptySummary;
  verifyFeatureMappingProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => {
    const existing = nodeById.get(node.nodeId);
    if (existing) return existing;
    nodeById.set(node.nodeId, node);
    nodes.push(node);
    return node;
  };
  const currentRevisionByLogical = new Map(edges
    .filter((edge) => edge.type === "CURRENT_REVISION")
    .map((edge) => [edge.from, edge.to]));
  const ensureEndpoint = (endpoint, evidenceIds) => {
    const existing = nodeById.get(endpoint.nodeId);
    if (existing && existing.kind === endpoint.kind) {
      const currentRevisionId = currentRevisionByLogical.get(endpoint.nodeId) || null;
      const approvedContinuityGeneration = endpoint.continuityGeneration ?? 0;
      const currentContinuityGeneration = continuityGenerationByLogicalEntityId[endpoint.nodeId] || 0;
      const continuityUnknown = continuityUnknownLogicalEntityIds.has(endpoint.nodeId);
      const reintroduced = approvedContinuityGeneration !== currentContinuityGeneration;
      const evidenceStatus = !currentRevisionId || continuityUnknown ? "unavailable"
        : currentRevisionId === endpoint.revisionId
          ? reintroduced ? "reintroduced" : "unchanged"
          : reintroduced ? "reintroduced" : "changed";
      return {
        node: existing,
        present: true,
        endpointStatus: evidenceStatus === "reintroduced" ? "reintroduced" : "present",
        evidenceStatus,
        currentRevisionId,
        approvedContinuityGeneration,
        currentContinuityGeneration: continuityUnknown ? null : currentContinuityGeneration,
      };
    }
    const reference = pushNode({
      nodeId: endpoint.nodeId,
      kind: "MappingEndpointReference",
      referencedNodeId: endpoint.nodeId,
      referencedKind: endpoint.kind,
      referencedRevisionId: endpoint.revisionId,
      path: endpoint.path || "",
      name: endpoint.name || "",
      key: endpoint.key || "",
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "historical-feature-mapping-endpoint", freshness: "historical" }),
    });
    return {
      node: reference,
      present: false,
      endpointStatus: "missing",
      evidenceStatus: "unavailable",
      currentRevisionId: null,
      approvedContinuityGeneration: endpoint.continuityGeneration ?? 0,
      currentContinuityGeneration: null,
    };
  };
  const candidateById = new Map();

  for (const candidateSet of projection.candidateSets) {
    const setEvidenceId = identity("evidence", {
      kind: "feature-mapping-candidate-set",
      candidateSetId: candidateSet.candidateSetId,
      candidateSetHash: candidateSet.candidateSetHash,
    });
    pushNode({
      nodeId: candidateSet.candidateSetId,
      kind: "FeatureMappingCandidateSet",
      projectId,
      sessionId: candidateSet.sessionId,
      candidateSetHash: candidateSet.candidateSetHash,
      evidenceWorldModelId: candidateSet.worldModelId,
      evidenceGraphSnapshotId: candidateSet.graphSnapshotId,
      evidenceSourceSnapshotId: candidateSet.sourceSnapshotId,
      evidenceProductModelId: candidateSet.productModelId,
      evidenceProductModelHash: candidateSet.productModelHash,
      candidateIds: candidateSet.candidates.map((candidate) => candidate.candidateId),
      featureMappingEvidenceIds: candidateSet.evidence.map((evidence) => evidence.evidenceId),
      unknownIds: candidateSet.unknowns.map((unknown) => unknown.unknownId),
      ...nodeMetadata({ evidenceIds: [setEvidenceId, ...candidateSet.evidence.map((item) => item.evidenceId)], sourceSnapshotId, origin: "feature-mapping-candidate-set" }),
    });
    for (const evidence of candidateSet.evidence) {
      pushNode({
        nodeId: evidence.evidenceId,
        kind: "FeatureMappingEvidence",
        featureMappingEvidenceHash: evidence.evidenceHash,
        sourceKind: evidence.sourceKind,
        sourceNodeId: evidence.sourceNodeId,
        sourceRevisionId: evidence.sourceRevisionId,
        path: evidence.path,
        line: evidence.line,
        contentDigest: evidence.contentDigest,
        statement: evidence.statement,
        ...nodeMetadata({ evidenceIds: [evidence.evidenceId], sourceSnapshotId, origin: `feature-mapping-evidence:${evidence.sourceKind}` }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: candidateSet.candidateSetId, to: evidence.evidenceId,
        sourceSnapshotId, evidenceIds: [evidence.evidenceId], origin: "feature-mapping-candidate-set" }));
    }
    for (const candidate of candidateSet.candidates) {
      candidateById.set(candidate.candidateId, { candidate, candidateSet });
      pushNode({
        nodeId: candidate.candidateId,
        kind: "FeatureMappingCandidate",
        candidateHash: candidate.candidateHash,
        relationshipType: candidate.relationshipType,
        proposedFromNodeId: candidate.from.nodeId,
        proposedFromKind: candidate.from.kind,
        proposedToNodeId: candidate.to.nodeId,
        proposedToKind: candidate.to.kind,
        evidenceSourceSnapshotId: candidate.sourceSnapshotId,
        explanation: candidate.explanation,
        ...nodeMetadata({ evidenceIds: candidate.evidenceIds, sourceSnapshotId, authorityClass: "heuristic", origin: candidate.origin, confidence: candidate.confidence }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: candidateSet.candidateSetId, to: candidate.candidateId,
        sourceSnapshotId, evidenceIds: candidate.evidenceIds, origin: "feature-mapping-candidate-set" }));
      const from = ensureEndpoint(candidate.from, candidate.evidenceIds);
      const to = ensureEndpoint(candidate.to, candidate.evidenceIds);
      edges.push(edgeRecord({ type: "PROPOSES_FROM", from: candidate.candidateId, to: from.node.nodeId,
        sourceSnapshotId, evidenceIds: candidate.evidenceIds, origin: candidate.origin, authorityClass: "heuristic", confidence: candidate.confidence }));
      edges.push(edgeRecord({ type: "PROPOSES_TO", from: candidate.candidateId, to: to.node.nodeId,
        sourceSnapshotId, evidenceIds: candidate.evidenceIds, origin: candidate.origin, authorityClass: "heuristic", confidence: candidate.confidence }));
      for (const evidenceId of candidate.evidenceIds) edges.push(edgeRecord({ type: "SUPPORTED_BY", from: candidate.candidateId, to: evidenceId,
        sourceSnapshotId, evidenceIds: [evidenceId], origin: candidate.origin, authorityClass: "heuristic", confidence: candidate.confidence }));
    }
    for (const unknown of candidateSet.unknowns) {
      pushNode({
        nodeId: unknown.unknownId,
        kind: "FeatureMappingUnknown",
        statement: unknown.statement,
        unknownStatus: unknown.status,
        ...nodeMetadata({ evidenceIds: unknown.evidenceIds, sourceSnapshotId, origin: "feature-mapping-explicit-unknown" }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: candidateSet.candidateSetId, to: unknown.unknownId,
        sourceSnapshotId, evidenceIds: unknown.evidenceIds, origin: "feature-mapping-candidate-set" }));
    }
  }

  let reviewedRelationshipCount = 0;
  let activeReviewedRelationshipCount = 0;
  for (const review of projection.reviewDecisions) {
    const reviewEvidenceId = identity("evidence", {
      kind: "feature-mapping-review-decision",
      reviewDecisionId: review.reviewDecisionId,
      reviewDecisionHash: review.reviewDecisionHash,
    });
    pushNode({
      nodeId: review.reviewDecisionId,
      kind: "FeatureMappingReviewDecision",
      projectId,
      sessionId: review.sessionId,
      reviewDecisionHash: review.reviewDecisionHash,
      candidateSetId: review.candidateSetId,
      disposition: review.disposition,
      acceptedCandidateIds: review.acceptedCandidateIds,
      rejectedCandidateIds: review.rejectedCandidateIds,
      evidenceSourceSnapshotId: review.sourceSnapshotId,
      evidenceProductModelId: review.productModelId,
      evidenceProductModelHash: review.productModelHash,
      rationale: review.rationale,
      sourceAuthority: review.authority,
      sourcePromotionAuthority: review.promotionAuthority,
      ...nodeMetadata({ evidenceIds: [reviewEvidenceId], sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-feature-mapping-review" }),
    });
    edges.push(edgeRecord({ type: "REVIEWED_BY", from: review.candidateSetId, to: review.reviewDecisionId,
      sourceSnapshotId, evidenceIds: [reviewEvidenceId], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
    for (const candidateId of review.acceptedCandidateIds) {
      const candidate = candidateById.get(candidateId)?.candidate;
      edges.push(edgeRecord({ type: "ACCEPTED_BY", from: candidateId, to: review.reviewDecisionId,
        sourceSnapshotId, evidenceIds: [reviewEvidenceId], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
      if (!candidate) continue;
      const from = ensureEndpoint(candidate.from, candidate.evidenceIds);
      const to = ensureEndpoint(candidate.to, candidate.evidenceIds);
      const receiptPayload = reviewedRelationshipIdentityPayload({ review, candidate });
      const relationshipNodeId = identity("reviewed-relationship", receiptPayload);
      const active = from.evidenceStatus === "unchanged" && to.evidenceStatus === "unchanged";
      const endpointStatus = !from.present || !to.present ? "missing"
        : from.endpointStatus === "reintroduced" || to.endpointStatus === "reintroduced" ? "reintroduced" : "present";
      const evidenceStatus = from.evidenceStatus === "unavailable" || to.evidenceStatus === "unavailable" ? "unavailable"
        : from.evidenceStatus === "reintroduced" || to.evidenceStatus === "reintroduced" ? "reintroduced"
          : from.evidenceStatus === "changed" || to.evidenceStatus === "changed" ? "changed" : "unchanged";
      const semanticAssessmentStatus = evidenceStatus === "unchanged" ? "assessed"
        : evidenceStatus === "changed" ? "needs-recheck" : "not-assessed";
      const projectionStatus = active ? "current"
        : endpointStatus === "missing" ? "stale-endpoint"
          : endpointStatus === "reintroduced" ? "reintroduced-endpoint" : "stale-evidence";
      pushNode({
        nodeId: relationshipNodeId,
        kind: "ReviewedRelationship",
        ...receiptPayload,
        candidateHash: candidate.candidateHash,
        reviewDecisionHash: review.reviewDecisionHash,
        approvalStatus: "approved",
        endpointStatus,
        evidenceStatus,
        semanticAssessmentStatus,
        projectionStatus,
        projectionCurrent: active,
        currentFromRevisionId: from.currentRevisionId,
        currentToRevisionId: to.currentRevisionId,
        approvedFromContinuityGeneration: from.approvedContinuityGeneration,
        approvedToContinuityGeneration: to.approvedContinuityGeneration,
        currentFromContinuityGeneration: from.currentContinuityGeneration,
        currentToContinuityGeneration: to.currentContinuityGeneration,
        userActionRequired: false,
        ...nodeMetadata({
          evidenceIds: [reviewEvidenceId, ...candidate.evidenceIds],
          sourceSnapshotId,
          authorityClass: "reviewed",
          origin: "explicit-user-feature-mapping-review",
          freshness: active ? "current" : "stale",
        }),
      });
      edges.push(edgeRecord({ type: "PROMOTED_FROM", from: relationshipNodeId, to: candidateId,
        sourceSnapshotId, evidenceIds: [reviewEvidenceId, ...candidate.evidenceIds], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
      edges.push(edgeRecord({ type: "PRODUCES", from: review.reviewDecisionId, to: relationshipNodeId,
        sourceSnapshotId, evidenceIds: [reviewEvidenceId, ...candidate.evidenceIds], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
      if (active) {
        edges.push(edgeRecord({ type: candidate.relationshipType, from: candidate.from.nodeId, to: candidate.to.nodeId,
          sourceSnapshotId, evidenceIds: [reviewEvidenceId, ...candidate.evidenceIds], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
        activeReviewedRelationshipCount += 1;
      }
      reviewedRelationshipCount += 1;
    }
    for (const candidateId of review.rejectedCandidateIds) edges.push(edgeRecord({ type: "REJECTED_BY", from: candidateId, to: review.reviewDecisionId,
      sourceSnapshotId, evidenceIds: [reviewEvidenceId], origin: "explicit-user-feature-mapping-review", authorityClass: "reviewed" }));
  }

  return {
    featureMappingCandidateSetCount: projection.candidateSets.length,
    featureMappingCandidateCount: new Set(projection.candidateSets.flatMap((item) => item.candidates.map((candidate) => candidate.candidateId))).size,
    featureMappingEvidenceCount: new Set(projection.candidateSets.flatMap((item) => item.evidence.map((evidence) => evidence.evidenceId))).size,
    featureMappingUnknownCount: new Set(projection.candidateSets.flatMap((item) => item.unknowns.map((unknown) => unknown.unknownId))).size,
    featureMappingReviewDecisionCount: projection.reviewDecisions.length,
    featureMappingAcceptedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.acceptedCandidateIds.length, 0),
    featureMappingRejectedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.rejectedCandidateIds.length, 0),
    reviewedRelationshipCount,
    activeReviewedRelationshipCount,
  };
}

function changeSetProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided",
    projectionInputId: null,
    projectionInputHash: null,
    changeSetIds: [],
    candidateSetIds: [],
    reviewDecisionIds: [],
    vcsEvidenceIds: [],
  };
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    changeSetIds: projection.changeSets.map((item) => item.changeSetId),
    candidateSetIds: projection.candidateSets.map((item) => item.candidateSetId),
    reviewDecisionIds: projection.reviewDecisions.map((item) => item.reviewDecisionId),
    vcsEvidenceIds: (projection.vcsEvidence || []).map((item) => item.vcsEvidenceId),
  };
}

function appendChangeSetProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const emptySummary = {
    changeSetCount: 0,
    changeRecordCount: 0,
    changeImpactCandidateSetCount: 0,
    changeImpactCandidateCount: 0,
    changeImpactUnknownCount: 0,
    changeImpactReviewDecisionCount: 0,
    changeImpactAcceptedCandidateCount: 0,
    changeImpactRejectedCandidateCount: 0,
    reviewedImpactCount: 0,
    activeReviewedImpactCount: 0,
    vcsEvidenceCount: 0,
    gitCommitObservationCount: 0,
  };
  if (!projection) return emptySummary;
  verifyChangeSetProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => {
    const existing = nodeById.get(node.nodeId);
    if (existing) return existing;
    nodeById.set(node.nodeId, node);
    nodes.push(node);
    return node;
  };
  const ensureExecutionReference = (artifactId, artifactKind, evidenceIds) => pushNode({
    nodeId: artifactId,
    kind: "ExecutionLineageReference",
    referencedArtifactId: artifactId,
    referencedArtifactKind: artifactKind,
    ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "execution-lineage-reference", freshness: "historical" }),
  });
  const ensureProductEndpoint = (target, evidenceIds) => {
    const existing = nodeById.get(target.nodeId);
    if (existing) {
      const revision = nodeById.get(target.revisionId);
      return { node: existing, active: existing.kind === target.kind && revision?.kind === `${target.kind}Revision` && revision.logicalEntityId === target.nodeId };
    }
    return {
      node: pushNode({
        nodeId: target.nodeId,
        kind: "ChangeProductReference",
        referencedNodeId: target.nodeId,
        referencedKind: target.kind,
        referencedRevisionId: target.revisionId,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "historical-change-impact-endpoint", freshness: "historical" }),
      }),
      active: false,
    };
  };
  const changeSetById = new Map();
  const changeSetFreshness = new Map();
  const candidateById = new Map();

  for (const changeSet of projection.changeSets) {
    changeSetById.set(changeSet.changeSetId, changeSet);
    const projectedFreshness = changeSet.after.sourceSnapshotId === sourceSnapshotId ? "current" : "historical";
    changeSetFreshness.set(changeSet.changeSetId, projectedFreshness);
    const evidenceIds = [changeSet.resultPacketId, changeSet.reviewDecisionId].sort();
    pushNode({
      nodeId: changeSet.changeSetId,
      kind: "ChangeSet",
      projectId,
      sessionId: changeSet.sessionId,
      changeSetHash: changeSet.changeSetHash,
      parentChangeSetIds: changeSet.parentChangeSetIds,
      beforeGraphSnapshotId: changeSet.before.graphSnapshotId,
      beforeSourceSnapshotId: changeSet.before.sourceSnapshotId,
      afterGraphSnapshotId: changeSet.after.graphSnapshotId,
      afterSourceSnapshotId: changeSet.after.sourceSnapshotId,
      wholePlanId: changeSet.wholePlanId,
      executionContractId: changeSet.executionContractId,
      resultPacketId: changeSet.resultPacketId,
      executionReviewDecisionId: changeSet.reviewDecisionId,
      reviewDisposition: changeSet.reviewDisposition,
      changeIds: changeSet.changes.map((item) => item.changeId),
      sourceAuthority: changeSet.authority,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, authorityClass: "reviewed", origin: "reviewed-execution-change-lineage", freshness: projectedFreshness }),
    });
    ensureExecutionReference(changeSet.resultPacketId, "ResultPacket", evidenceIds);
    ensureExecutionReference(changeSet.reviewDecisionId, "ReviewDecision", evidenceIds);
    edges.push(edgeRecord({ type: "SUPPORTED_BY", from: changeSet.changeSetId, to: changeSet.resultPacketId,
      sourceSnapshotId, evidenceIds, origin: "reviewed-execution-change-lineage", authorityClass: "reviewed", freshness: projectedFreshness }));
    edges.push(edgeRecord({ type: "REVIEWED_BY", from: changeSet.changeSetId, to: changeSet.reviewDecisionId,
      sourceSnapshotId, evidenceIds, origin: "reviewed-execution-change-lineage", authorityClass: "reviewed", freshness: projectedFreshness }));
    for (const parentId of changeSet.parentChangeSetIds) edges.push(edgeRecord({ type: "SUPERSEDES", from: changeSet.changeSetId, to: parentId,
      sourceSnapshotId, evidenceIds, origin: "declared-change-set-parent", authorityClass: "reviewed", freshness: projectedFreshness }));
    for (const change of changeSet.changes) {
      const reference = (role, revisionId) => {
        if (!revisionId) return null;
        const nodeId = identity("change-revision-reference", { changeSetId: changeSet.changeSetId, changeId: change.changeId, role, revisionId });
        return pushNode({
          nodeId,
          kind: "ChangeRevisionReference",
          changeSetId: changeSet.changeSetId,
          changeId: change.changeId,
          role,
          referencedRevisionId: revisionId,
          logicalEntityId: change.logicalEntityId,
          referencedKind: `${change.entityKind}Revision`,
          path: change.path,
          name: change.name,
          ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "change-set-revision-reference", freshness: projectedFreshness === "historical" || role === "before" ? "historical" : "current" }),
        });
      };
      const before = reference("before", change.beforeRevisionId);
      const after = reference("after", change.afterRevisionId);
      for (const revision of [before, after].filter(Boolean)) edges.push(edgeRecord({ type: "CHANGES", from: changeSet.changeSetId, to: revision.nodeId,
        sourceSnapshotId, evidenceIds, origin: "reviewed-execution-change-lineage", authorityClass: "reviewed", freshness: projectedFreshness }));
      for (const revision of [before, after].filter(Boolean)) if (nodeById.has(revision.referencedRevisionId)) edges.push(edgeRecord({
        type: "REFERENCES", from: revision.nodeId, to: revision.referencedRevisionId,
        sourceSnapshotId, evidenceIds, origin: "exact-change-revision-lineage", authorityClass: "reviewed", freshness: revision.freshness,
      }));
      if (before && after) edges.push(edgeRecord({ type: "SUPERSEDES", from: after.nodeId, to: before.nodeId,
        sourceSnapshotId, evidenceIds, origin: "reviewed-execution-change-lineage", authorityClass: "reviewed", freshness: projectedFreshness }));
    }
  }

  const observationFreshness = new Map();
  for (const evidence of projection.vcsEvidence || []) {
    const freshness = changeSetFreshness.get(evidence.changeSetId) || "historical";
    for (const observation of evidence.commitObservations) {
      if (freshness === "current" || !observationFreshness.has(observation.gitCommitObservationId)) {
        observationFreshness.set(observation.gitCommitObservationId, freshness);
      }
    }
  }
  for (const evidence of projection.vcsEvidence || []) {
    const projectedFreshness = changeSetFreshness.get(evidence.changeSetId) || "historical";
    const observationIds = evidence.commitObservations.map((item) => item.gitCommitObservationId).sort();
    pushNode({
      nodeId: evidence.vcsEvidenceId,
      kind: "VcsEvidence",
      projectId,
      sessionId: evidence.sessionId,
      vcsEvidenceHash: evidence.vcsEvidenceHash,
      changeSetId: evidence.changeSetId,
      changeSetHash: evidence.changeSetHash,
      vcsKind: evidence.vcsKind,
      attachmentMethod: evidence.attachmentMethod,
      rationale: evidence.rationale,
      gitHistoryId: evidence.gitHistory.historyId,
      gitHistoryHash: evidence.gitHistory.historyHash,
      gitHistoryCoverage: evidence.gitHistory.coverage,
      gitCommitObservationIds: observationIds,
      sourceAuthority: evidence.authority,
      trustBoundary: evidence.trustBoundary,
      ...nodeMetadata({ evidenceIds: observationIds, sourceSnapshotId, origin: "explicit-vcs-evidence-attachment", freshness: projectedFreshness }),
    });
    edges.push(edgeRecord({
      type: "MATERIALIZED_AS",
      from: evidence.changeSetId,
      to: evidence.vcsEvidenceId,
      sourceSnapshotId,
      evidenceIds: observationIds,
      origin: "explicit-vcs-evidence-attachment",
      freshness: projectedFreshness,
    }));
    for (const observation of evidence.commitObservations) {
      pushNode({
        nodeId: observation.gitCommitObservationId,
        kind: "GitCommit",
        vcsKind: observation.vcsKind,
        gitCommitObservationHash: observation.gitCommitObservationHash,
        objectId: observation.objectId,
        parentObjectIds: observation.parents,
        authoredAt: observation.authoredAt,
        committedAt: observation.committedAt,
        authorName: observation.author.name,
        authorEmailDigest: observation.authorEmailDigest,
        refs: observation.refs,
        subject: observation.subject,
        body: observation.body,
        trustBoundary: observation.trustBoundary,
        sourceAuthority: observation.authority,
        ...nodeMetadata({ evidenceIds: [observation.objectId], sourceSnapshotId, origin: "git-history-observation", freshness: observationFreshness.get(observation.gitCommitObservationId) || "historical" }),
      });
      edges.push(edgeRecord({
        type: "REFERENCES",
        from: evidence.vcsEvidenceId,
        to: observation.gitCommitObservationId,
        sourceSnapshotId,
        evidenceIds: [observation.gitCommitObservationId],
        origin: "explicit-vcs-evidence-attachment",
        freshness: projectedFreshness,
      }));
    }
  }

  for (const candidateSet of projection.candidateSets) {
    const evidenceIds = [candidateSet.changeSetId];
    const projectedFreshness = changeSetFreshness.get(candidateSet.changeSetId) || "historical";
    pushNode({
      nodeId: candidateSet.candidateSetId,
      kind: "ChangeImpactCandidateSet",
      projectId,
      sessionId: candidateSet.sessionId,
      candidateSetHash: candidateSet.candidateSetHash,
      changeSetId: candidateSet.changeSetId,
      afterSourceSnapshotId: candidateSet.afterSourceSnapshotId,
      afterGraphSnapshotId: candidateSet.afterGraphSnapshotId,
      candidateIds: candidateSet.candidates.map((item) => item.candidateId),
      unknownIds: candidateSet.unknowns.map((item) => item.unknownId),
      coverage: candidateSet.coverage || null,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "change-impact-candidate-set", freshness: projectedFreshness }),
    });
    for (const candidate of candidateSet.candidates) {
      candidateById.set(candidate.candidateId, { candidate, candidateSet });
      const candidateEvidence = [candidateSet.changeSetId, ...candidate.reviewedRelationshipIds].sort();
      pushNode({
        nodeId: candidate.candidateId,
        kind: "ChangeImpactCandidate",
        candidateHash: candidate.candidateHash,
        changeSetId: candidate.changeSetId,
        relationshipType: candidate.relationshipType,
        targetNodeId: candidate.target.nodeId,
        targetKind: candidate.target.kind,
        targetRevisionId: candidate.target.revisionId,
        changeIds: candidate.changeIds,
        reviewedRelationshipIds: candidate.reviewedRelationshipIds,
        explanation: candidate.explanation,
        ...nodeMetadata({ evidenceIds: candidateEvidence, sourceSnapshotId, authorityClass: "heuristic", origin: "reviewed-mapping-change-impact-inference", confidence: candidate.confidence, freshness: projectedFreshness }),
      });
      ensureProductEndpoint(candidate.target, candidateEvidence);
      edges.push(edgeRecord({ type: "CONTAINS", from: candidateSet.candidateSetId, to: candidate.candidateId,
        sourceSnapshotId, evidenceIds: candidateEvidence, origin: "change-impact-candidate-set", freshness: projectedFreshness }));
      edges.push(edgeRecord({ type: "SUPPORTED_BY", from: candidate.candidateId, to: candidate.changeSetId,
        sourceSnapshotId, evidenceIds: candidateEvidence, origin: "reviewed-mapping-change-impact-inference", authorityClass: "heuristic", confidence: candidate.confidence, freshness: projectedFreshness }));
      edges.push(edgeRecord({ type: "PROPOSES_TO", from: candidate.candidateId, to: candidate.target.nodeId,
        sourceSnapshotId, evidenceIds: candidateEvidence, origin: "reviewed-mapping-change-impact-inference", authorityClass: "heuristic", confidence: candidate.confidence, freshness: projectedFreshness }));
    }
    for (const unknown of candidateSet.unknowns) {
      pushNode({
        nodeId: unknown.unknownId,
        kind: "ChangeImpactUnknown",
        changeSetId: candidateSet.changeSetId,
        unknownKind: unknown.kind || "unmapped-change-coverage",
        changeIds: unknown.changeIds || [],
        statement: unknown.statement,
        unknownStatus: unknown.status,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "change-impact-explicit-unknown", freshness: projectedFreshness }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: candidateSet.candidateSetId, to: unknown.unknownId,
        sourceSnapshotId, evidenceIds, origin: "change-impact-candidate-set", freshness: projectedFreshness }));
    }
  }

  let reviewedImpactCount = 0;
  let activeReviewedImpactCount = 0;
  for (const review of projection.reviewDecisions) {
    const reviewEvidence = [review.changeSetId, review.reviewDecisionId].sort();
    const projectedFreshness = changeSetFreshness.get(review.changeSetId) || "historical";
    pushNode({
      nodeId: review.reviewDecisionId,
      kind: "ChangeImpactReviewDecision",
      projectId,
      sessionId: review.sessionId,
      reviewDecisionHash: review.reviewDecisionHash,
      changeSetId: review.changeSetId,
      candidateSetId: review.candidateSetId,
      disposition: review.disposition,
      acceptedCandidateIds: review.acceptedCandidateIds,
      rejectedCandidateIds: review.rejectedCandidateIds,
      rationale: review.rationale,
      sourceAuthority: review.authority,
      sourcePromotionAuthority: review.promotionAuthority,
      ...nodeMetadata({ evidenceIds: reviewEvidence, sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-change-impact-review", freshness: projectedFreshness }),
    });
    edges.push(edgeRecord({ type: "REVIEWED_BY", from: review.candidateSetId, to: review.reviewDecisionId,
      sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
    for (const candidateId of review.acceptedCandidateIds) {
      const candidate = candidateById.get(candidateId)?.candidate;
      edges.push(edgeRecord({ type: "ACCEPTED_BY", from: candidateId, to: review.reviewDecisionId,
        sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
      if (!candidate) continue;
      const target = ensureProductEndpoint(candidate.target, reviewEvidence);
      const receiptPayload = {
        projectId,
        reviewDecisionId: review.reviewDecisionId,
        candidateId,
        changeSetId: candidate.changeSetId,
        targetNodeId: candidate.target.nodeId,
        targetKind: candidate.target.kind,
        targetRevisionId: candidate.target.revisionId,
      };
      const receiptId = identity("reviewed-impact", receiptPayload);
      const active = target.active && projectedFreshness === "current";
      pushNode({
        nodeId: receiptId,
        kind: "ReviewedImpact",
        ...receiptPayload,
        candidateHash: candidate.candidateHash,
        reviewDecisionHash: review.reviewDecisionHash,
        projectionStatus: active ? "current" : target.active ? "historical-source" : "stale-endpoint",
        ...nodeMetadata({ evidenceIds: reviewEvidence, sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-change-impact-review", freshness: active ? "current" : target.active ? "historical" : "stale" }),
      });
      edges.push(edgeRecord({ type: "PROMOTED_FROM", from: receiptId, to: candidateId,
        sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
      edges.push(edgeRecord({ type: "PRODUCES", from: review.reviewDecisionId, to: receiptId,
        sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
      if (active) {
        edges.push(edgeRecord({ type: "AT_REVISION", from: receiptId, to: candidate.target.revisionId,
          sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
        edges.push(edgeRecord({ type: "IMPACTS", from: candidate.changeSetId, to: candidate.target.nodeId,
          sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
        activeReviewedImpactCount += 1;
      }
      reviewedImpactCount += 1;
    }
    for (const candidateId of review.rejectedCandidateIds) edges.push(edgeRecord({ type: "REJECTED_BY", from: candidateId, to: review.reviewDecisionId,
      sourceSnapshotId, evidenceIds: reviewEvidence, origin: "explicit-user-change-impact-review", authorityClass: "reviewed", freshness: projectedFreshness }));
  }
  return {
    changeSetCount: projection.changeSets.length,
    changeRecordCount: projection.changeSets.reduce((count, item) => count + item.changes.length, 0),
    changeImpactCandidateSetCount: projection.candidateSets.length,
    changeImpactCandidateCount: projection.candidateSets.reduce((count, item) => count + item.candidates.length, 0),
    changeImpactUnknownCount: projection.candidateSets.reduce((count, item) => count + item.unknowns.length, 0),
    changeImpactReviewDecisionCount: projection.reviewDecisions.length,
    changeImpactAcceptedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.acceptedCandidateIds.length, 0),
    changeImpactRejectedCandidateCount: projection.reviewDecisions.reduce((count, item) => count + item.rejectedCandidateIds.length, 0),
    reviewedImpactCount,
    activeReviewedImpactCount,
    vcsEvidenceCount: (projection.vcsEvidence || []).length,
    gitCommitObservationCount: new Set((projection.vcsEvidence || []).flatMap((item) => item.commitObservations.map((observation) => observation.gitCommitObservationId))).size,
  };
}

function documentChangeProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided", projectionInputId: null, projectionInputHash: null,
    candidateSetIds: [], reviewDecisionIds: [], productModelRevisionIds: [], applicationReceiptIds: [],
  };
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    candidateSetIds: projection.candidateSets.map((item) => item.candidateSetId),
    reviewDecisionIds: projection.reviewDecisions.map((item) => item.reviewDecisionId),
    productModelRevisionIds: projection.productModelRevisions.map((item) => `document-product-model-revision-${item.revisionHash.slice(0, 24)}`),
    applicationReceiptIds: projection.applicationReceipts.map((item) => item.applicationReceiptId),
  };
}

function appendDocumentChangeProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const empty = {
    documentChangeCandidateSetCount: 0,
    documentChangeCandidateCount: 0,
    documentChangeReviewDecisionCount: 0,
    documentChangeProductModelRevisionCount: 0,
    documentChangeApplicationCount: 0,
    documentProjectionReferenceCount: 0,
  };
  if (!projection) return empty;
  verifyDocumentChangeProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => {
    const existing = nodeById.get(node.nodeId);
    if (existing) return existing;
    nodeById.set(node.nodeId, node);
    nodes.push(node);
    return node;
  };
  const references = new Map();
  const ensureProjectionReference = ({ documentProjectionId, documentProjectionHash, graphSnapshotId, graphSnapshotHash, referencedSourceSnapshotId }) => {
    const nodeId = identity("document-projection-reference", { projectId, documentProjectionId, documentProjectionHash, graphSnapshotId, graphSnapshotHash, referencedSourceSnapshotId });
    if (!references.has(nodeId)) references.set(nodeId, pushNode({
      nodeId,
      kind: "DocumentProjectionReference",
      projectId,
      documentProjectionId,
      documentProjectionHash,
      graphSnapshotId,
      graphSnapshotHash,
      referencedSourceSnapshotId,
      ...nodeMetadata({ evidenceIds: [documentProjectionId, graphSnapshotId], sourceSnapshotId, origin: "document-projection-lineage-reference", freshness: "historical" }),
    }));
    return nodeId;
  };
  const candidateById = new Map();
  for (const set of projection.candidateSets) {
    const evidenceIds = [set.candidateSetId, set.documentProjectionId, set.graphSnapshotId].sort();
    const referenceId = ensureProjectionReference({
      documentProjectionId: set.documentProjectionId,
      documentProjectionHash: set.documentProjectionHash,
      graphSnapshotId: set.graphSnapshotId,
      graphSnapshotHash: set.graphSnapshotHash,
      referencedSourceSnapshotId: set.sourceSnapshotId,
    });
    pushNode({
      nodeId: set.candidateSetId,
      kind: "DocumentChangeCandidateSet",
      projectId,
      candidateSetHash: set.candidateSetHash,
      documentProjectionId: set.documentProjectionId,
      graphSnapshotId: set.graphSnapshotId,
      referencedSourceSnapshotId: set.sourceSnapshotId,
      candidateIds: set.candidates.map((candidate) => candidate.candidateId),
      sourceAuthority: set.authority,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "document-projection-edit-candidate-set", freshness: "historical" }),
    });
    edges.push(edgeRecord({ type: "PROPOSES_FROM", from: set.candidateSetId, to: referenceId, sourceSnapshotId, evidenceIds, origin: "document-projection-edit-candidate-set", freshness: "historical" }));
    for (const candidate of set.candidates) {
      candidateById.set(candidate.candidateId, candidate);
      pushNode({
        nodeId: candidate.candidateId,
        kind: "DocumentChangeCandidate",
        candidateSetId: set.candidateSetId,
        relativePath: candidate.relativePath,
        changeType: candidate.changeType,
        baseContentHash: candidate.baseContentHash,
        proposedContentHash: candidate.proposedContentHash,
        sourceAuthority: candidate.authority,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId, origin: "document-projection-edit-candidate", freshness: "historical" }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: set.candidateSetId, to: candidate.candidateId, sourceSnapshotId, evidenceIds, origin: "document-projection-edit-candidate", freshness: "historical" }));
    }
  }
  const revisionByProductModelId = new Map(projection.productModelRevisions.map((revision) => [revision.productModelId, revision]));
  for (const review of projection.reviewDecisions) {
    const evidenceIds = [review.reviewDecisionId, review.candidateSetId].sort();
    pushNode({
      nodeId: review.reviewDecisionId,
      kind: "DocumentChangeReviewDecision",
      projectId,
      reviewDecisionHash: review.reviewDecisionHash,
      candidateSetId: review.candidateSetId,
      disposition: review.disposition,
      acceptedCandidateIds: review.acceptedCandidateIds,
      rejectedCandidateIds: review.rejectedCandidateIds,
      rationale: review.rationale,
      resultingProductModelId: review.resultingProductModelId,
      sourceAuthority: review.authority,
      sourcePromotionAuthority: review.promotionAuthority,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-document-change-review", freshness: "historical" }),
    });
    edges.push(edgeRecord({ type: "REVIEWED_BY", from: review.candidateSetId, to: review.reviewDecisionId, sourceSnapshotId, evidenceIds, origin: "explicit-user-document-change-review", authorityClass: "reviewed", freshness: "historical" }));
    for (const candidateId of review.acceptedCandidateIds) edges.push(edgeRecord({ type: "ACCEPTED_BY", from: candidateId, to: review.reviewDecisionId, sourceSnapshotId, evidenceIds, origin: "explicit-user-document-change-review", authorityClass: "reviewed", freshness: "historical" }));
    for (const candidateId of review.rejectedCandidateIds) edges.push(edgeRecord({ type: "REJECTED_BY", from: candidateId, to: review.reviewDecisionId, sourceSnapshotId, evidenceIds, origin: "explicit-user-document-change-review", authorityClass: "reviewed", freshness: "historical" }));
    const revision = revisionByProductModelId.get(review.resultingProductModelId);
    if (revision) {
      const revisionEvidence = [review.reviewDecisionId, revision.productModelId].sort();
      const revisionNodeId = `document-product-model-revision-${revision.revisionHash.slice(0, 24)}`;
      pushNode({
        nodeId: revisionNodeId,
        kind: "DocumentProductModelRevision",
        projectId,
        productModelHash: revision.productModelHash,
        revisionHash: revision.revisionHash,
        sourceAuthority: revision.authority,
        ...nodeMetadata({ evidenceIds: revisionEvidence, sourceSnapshotId, authorityClass: "reviewed", origin: "explicit-user-document-change-review", freshness: "historical" }),
      });
      edges.push(edgeRecord({ type: "PRODUCES", from: review.reviewDecisionId, to: revisionNodeId, sourceSnapshotId, evidenceIds: revisionEvidence, origin: "explicit-user-document-change-review", authorityClass: "reviewed", freshness: "historical" }));
      for (const candidateId of review.acceptedCandidateIds) edges.push(edgeRecord({ type: "PROMOTED_FROM", from: revisionNodeId, to: candidateId, sourceSnapshotId, evidenceIds: revisionEvidence, origin: "explicit-user-document-change-review", authorityClass: "reviewed", freshness: "historical" }));
    }
  }
  for (const receipt of projection.applicationReceipts) {
    const evidenceIds = [receipt.applicationReceiptId, receipt.reviewDecisionId].sort();
    pushNode({
      nodeId: receipt.applicationReceiptId,
      kind: "DocumentChangeApplication",
      projectId,
      applicationReceiptHash: receipt.applicationReceiptHash,
      reviewDecisionId: receipt.reviewDecisionId,
      candidateSetId: receipt.candidateSetId,
      disposition: receipt.disposition,
      previousProductModelId: receipt.previousProductModelId,
      resultingProductModelId: receipt.resultingProductModelId,
      beforeWorldModelId: receipt.before.worldModelId,
      beforeGraphSnapshotId: receipt.before.graphSnapshotId,
      afterWorldModelId: receipt.after.worldModelId,
      afterGraphSnapshotId: receipt.after.graphSnapshotId,
      canonChanged: receipt.canonChanged,
      sourceAuthority: receipt.authority,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId, authorityClass: "reviewed", origin: "document-change-application-receipt", freshness: "historical" }),
    });
    const referenceId = ensureProjectionReference({
      documentProjectionId: receipt.after.documentProjectionId,
      documentProjectionHash: receipt.after.documentProjectionHash,
      graphSnapshotId: receipt.after.graphSnapshotId,
      graphSnapshotHash: receipt.after.graphSnapshotHash,
      referencedSourceSnapshotId: receipt.after.sourceSnapshotId,
    });
    edges.push(edgeRecord({ type: "PRODUCES", from: receipt.reviewDecisionId, to: receipt.applicationReceiptId, sourceSnapshotId, evidenceIds, origin: "document-change-application-receipt", authorityClass: "reviewed", freshness: "historical" }));
    edges.push(edgeRecord({ type: "PRODUCES", from: receipt.applicationReceiptId, to: referenceId, sourceSnapshotId, evidenceIds, origin: "document-change-application-receipt", authorityClass: "reviewed", freshness: "historical" }));
  }
  return {
    documentChangeCandidateSetCount: projection.candidateSets.length,
    documentChangeCandidateCount: projection.candidateSets.reduce((count, item) => count + item.candidates.length, 0),
    documentChangeReviewDecisionCount: projection.reviewDecisions.length,
    documentChangeProductModelRevisionCount: projection.productModelRevisions.length,
    documentChangeApplicationCount: projection.applicationReceipts.length,
    documentProjectionReferenceCount: references.size,
  };
}

function productOperatingProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided", projectionInputId: null, projectionInputHash: null,
    signalIds: [], hypothesisIds: [], initiativeCandidateIds: [], reviewDecisionIds: [],
    reviewedInitiativeIds: [], featureCandidateIds: [], outcomeObservationIds: [],
  };
  return {
    status: "projected", projectionInputId: projection.projectionInputId, projectionInputHash: projection.projectionInputHash,
    signalIds: projection.signals.map((item) => item.signalId),
    hypothesisIds: projection.hypotheses.map((item) => item.hypothesisId),
    initiativeCandidateIds: projection.initiativeCandidates.map((item) => item.initiativeCandidateId),
    reviewDecisionIds: projection.initiativeReviews.map((item) => item.reviewDecisionId),
    reviewedInitiativeIds: projection.reviewedInitiatives.map((item) => item.initiativeId),
    featureCandidateIds: projection.featureCandidates.map((item) => item.featureCandidateId),
    outcomeObservationIds: projection.outcomeObservations.map((item) => item.outcomeObservationId),
  };
}

function observationProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided", projectionId: null, projectionHash: null,
    descriptorIds: [], observationIds: [], derivedObservationIds: [], receiptIds: [],
  };
  return {
    status: "projected",
    projectionId: projection.projectionId,
    projectionHash: projection.projectionHash,
    descriptorIds: projection.descriptorIds,
    observationIds: projection.observationIds,
    derivedObservationIds: projection.derivedObservationIds,
    receiptIds: projection.receiptIds,
  };
}

function appendObservationProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const empty = { observationTypeDescriptorCount: 0, observationCollectionReceiptCount: 0, observationRecordCount: 0, derivedObservationRecordCount: 0 };
  if (!projection) return empty;
  verifyObservationProjection(projection, projectId);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const source of projection.nodes) {
    if (nodeById.has(source.nodeId)) fail(`Observation projection node collides with an existing temporal node: ${source.nodeId}`, "OBSERVATION_TEMPORAL_NODE_COLLISION");
    const { authority, semanticAuthority, ...fields } = source;
    const authorityClass = source.kind === "ObservationTypeDescriptor" || source.kind === "DerivedObservationRecord" ? "derived" : "runtime-observed";
    const freshness = source.kind === "ObservationTypeDescriptor" ? "current" : "historical";
    const node = {
      ...fields,
      projectId,
      sourceAuthority: authority,
      semanticAuthority,
      ...nodeMetadata({
        evidenceIds: [source.nodeId],
        sourceSnapshotId,
        authorityClass,
        origin: "common-observation-projection",
        freshness,
      }),
    };
    nodeById.set(node.nodeId, node);
    nodes.push(node);
  }
  for (const source of projection.edges) {
    edges.push(edgeRecord({
      type: source.type,
      from: source.from,
      to: source.to,
      sourceSnapshotId,
      evidenceIds: source.evidenceIds,
      origin: "common-observation-projection",
      authorityClass: "derived",
      freshness: "historical",
    }));
  }
  for (const source of projection.nodes.filter((node) => node.kind === "ObservationRecord"
    && node.typeKey === "delivery.state" && node.payload?.revision_binding === "verified-source-revision")) {
    const reference = {
      revisionId: source.payload.bound_revision_id,
      logicalEntityId: source.payload.bound_logical_entity_id,
      worldModelId: source.payload.bound_world_model_id,
      path: source.payload.bound_source_path,
      digest: source.payload.revision_digest,
    };
    if (!/^file-revision-[a-f0-9]{24}$/.test(reference.revisionId || "")
      || !/^file-[a-f0-9]{24}$/.test(reference.logicalEntityId || "")
      || !/^world-model-[a-f0-9]{24}$/.test(reference.worldModelId || "")
      || typeof reference.path !== "string" || !reference.path
      || !/^[a-f0-9]{64}$/.test(reference.digest || "")) {
      fail("Verified delivery Observation has an invalid source revision binding.", "DELIVERY_REVISION_REFERENCE_INVALID");
    }
    let revision = nodeById.get(reference.revisionId);
    if (revision) {
      if (!["FileRevision", "RevisionReference"].includes(revision.kind)
        || revision.logicalEntityId !== reference.logicalEntityId
        || revision.kind === "FileRevision" && (revision.path !== reference.path || revision.digest !== reference.digest)
        || revision.kind === "RevisionReference" && (revision.revisionKind !== "FileRevision"
          || revision.path != null && revision.path !== reference.path
          || revision.digest != null && revision.digest !== reference.digest)) {
        fail("Verified delivery Observation conflicts with its projected source revision.", "DELIVERY_REVISION_REFERENCE_INVALID");
      }
      if (revision.kind === "RevisionReference") {
        revision.path = reference.path;
        revision.digest = reference.digest;
        revision.referencedWorldModelId ??= reference.worldModelId;
      }
    } else {
      revision = {
        nodeId: reference.revisionId,
        kind: "RevisionReference",
        referencedRevisionId: reference.revisionId,
        revisionKind: "FileRevision",
        logicalEntityId: reference.logicalEntityId,
        referencedWorldModelId: reference.worldModelId,
        path: reference.path,
        digest: reference.digest,
        ...nodeMetadata({
          evidenceIds: [source.nodeId, reference.worldModelId],
          sourceSnapshotId,
          authorityClass: "derived",
          origin: "verified-delivery-revision-reference",
          freshness: "historical",
        }),
      };
      nodeById.set(revision.nodeId, revision);
      nodes.push(revision);
    }
    edges.push(edgeRecord({
      type: "AT_REVISION",
      from: source.nodeId,
      to: revision.nodeId,
      sourceSnapshotId,
      evidenceIds: [source.nodeId, reference.worldModelId],
      origin: "verified-delivery-revision-binding",
      authorityClass: "derived",
      freshness: "historical",
    }));
  }
  return {
    observationTypeDescriptorCount: projection.descriptorIds.length,
    observationCollectionReceiptCount: projection.receiptIds.length,
    observationRecordCount: projection.observationIds.length,
    derivedObservationRecordCount: projection.derivedObservationIds.length,
  };
}

function appendProductOperatingProjection({ projectId, productModelId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const empty = { productSignalCount: 0, productHypothesisCount: 0, productInitiativeCandidateCount: 0, productInitiativeReviewDecisionCount: 0, reviewedProductInitiativeCount: 0, productFeatureCandidateCount: 0, outcomeObservationCount: 0 };
  if (!projection) return empty;
  verifyProductOperatingProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => { const existing = nodeById.get(node.nodeId); if (existing) return existing; nodeById.set(node.nodeId, node); nodes.push(node); return node; };
  const evidence = (ids) => [...new Set(ids.filter(Boolean))].sort();
  const meta = (ids, authorityClass, origin, freshness = "current") => nodeMetadata({ evidenceIds: evidence(ids), sourceSnapshotId, authorityClass, origin, freshness });
  const add = (type, from, to, ids, authorityClass, origin) => edges.push(edgeRecord({ type, from, to, sourceSnapshotId, evidenceIds: evidence(ids), authorityClass, origin }));
  const featureByKey = new Map(nodes.filter((node) => node.kind === "Feature").map((node) => [node.key, node]));
  const featureCandidates = new Map(projection.featureCandidates.map((item) => [item.featureCandidateId, item]));

  for (const signal of projection.signals) pushNode({
    nodeId: signal.signalId, kind: "ProductSignal", projectId, signalHash: signal.signalHash, statement: signal.statement,
    observedAt: signal.observedAt, epistemicClass: signal.epistemicClass, sourceAuthority: signal.authority,
    ...meta([signal.signalId, ...signal.evidenceIds], "runtime-observed", "product-operating-observation"),
  });
  for (const hypothesis of projection.hypotheses) {
    for (const observationId of hypothesis.observationIds) {
      if (!["ObservationRecord", "DerivedObservationRecord"].includes(nodeById.get(observationId)?.kind)) fail("ProductHypothesis exact Observation is absent from the graph.", "PRODUCT_OPERATING_OBSERVATION_MISSING");
    }
    const neutral = hypothesis.referenceSemantics === "neutral";
    pushNode({ nodeId: hypothesis.hypothesisId, kind: "ProductHypothesis", projectId, hypothesisHash: hypothesis.hypothesisHash, statement: hypothesis.statement, rationale: hypothesis.rationale, signalIds: hypothesis.signalIds, observationIds: hypothesis.observationIds, ...(neutral ? { referenceSemantics: "neutral" } : {}), epistemicClass: hypothesis.epistemicClass, sourceAuthority: hypothesis.authority, ...meta([hypothesis.hypothesisId, ...hypothesis.signalIds, ...hypothesis.observationIds], "derived", "explicit-product-hypothesis") });
    // Preserve legacy immutable evidence semantics; only new neutral records opt in.
    for (const referenceId of [...hypothesis.signalIds, ...hypothesis.observationIds]) add(neutral ? "REFERENCES" : "SUPPORTED_BY", hypothesis.hypothesisId, referenceId, [hypothesis.hypothesisId, referenceId], "derived", "explicit-product-hypothesis");
  }
  for (const feature of projection.featureCandidates) pushNode({
    nodeId: feature.featureCandidateId, kind: "ProductFeatureCandidate", projectId, featureCandidateHash: feature.featureCandidateHash,
    feature: feature.feature, initiativeCandidateSeed: feature.initiativeCandidateSeed, epistemicClass: feature.epistemicClass,
    sourceAuthority: feature.authority, ...meta([feature.featureCandidateId], "derived", "product-feature-candidate"),
  });
  const targetFor = (resolution) => {
    if (resolution == null) return null;
    if (resolution.kind === "existing-feature") {
      const target = featureByKey.get(resolution.featureKey);
      if (target && resolution.productModelId === productModelId) return target.nodeId;
      const nodeId = identity("product-feature-reference", { projectId, featureKey: resolution.featureKey, productModelId: resolution.productModelId });
      pushNode({ nodeId, kind: "ProductFeatureReference", projectId, featureKey: resolution.featureKey, referencedProductModelId: resolution.productModelId, ...meta([resolution.productModelId], "derived", "historical-product-feature-reference", "historical") });
      return nodeId;
    }
    if (resolution.kind === "candidate") {
      if (!featureCandidates.has(resolution.featureCandidateId)) fail("Product Initiative references a missing Feature candidate.", "PRODUCT_OPERATING_FEATURE_CANDIDATE_MISSING");
      return resolution.featureCandidateId;
    }
    return null;
  };
  for (const initiative of projection.initiativeCandidates) {
    pushNode({ nodeId: initiative.initiativeCandidateId, kind: "ProductInitiativeCandidate", projectId, initiativeCandidateHash: initiative.initiativeCandidateHash, title: initiative.title, description: initiative.description, reasoning: initiative.reasoning || "", hypothesisIds: initiative.hypothesisIds, featureResolution: initiative.featureResolution, epistemicClass: initiative.epistemicClass, sourceAuthority: initiative.authority, ...meta([initiative.initiativeCandidateId, ...initiative.hypothesisIds], "derived", "product-initiative-candidate") });
    for (const hypothesisId of initiative.hypothesisIds) add("PROPOSES_FROM", initiative.initiativeCandidateId, hypothesisId, [initiative.initiativeCandidateId, hypothesisId], "derived", "product-initiative-candidate");
    const targetId = targetFor(initiative.featureResolution); if (targetId) add("PROPOSES_TO", initiative.initiativeCandidateId, targetId, [initiative.initiativeCandidateId, targetId], "derived", "product-initiative-candidate");
  }
  for (const review of projection.initiativeReviews) {
    pushNode({ nodeId: review.reviewDecisionId, kind: "ProductInitiativeReviewDecision", projectId, reviewDecisionHash: review.reviewDecisionHash, initiativeCandidateId: review.initiativeCandidateId, disposition: review.disposition, rationale: review.rationale, sourceAuthority: review.authority, sourcePromotionAuthority: review.promotionAuthority, ...meta([review.reviewDecisionId, review.initiativeCandidateId], "reviewed", "explicit-user-product-initiative-review") });
    add("REVIEWED_BY", review.initiativeCandidateId, review.reviewDecisionId, [review.initiativeCandidateId, review.reviewDecisionId], "reviewed", "explicit-user-product-initiative-review");
    add(review.disposition === "accept" ? "ACCEPTED_BY" : "REJECTED_BY", review.initiativeCandidateId, review.reviewDecisionId, [review.initiativeCandidateId, review.reviewDecisionId], "reviewed", "explicit-user-product-initiative-review");
  }
  for (const initiative of projection.reviewedInitiatives) {
    pushNode({ nodeId: initiative.initiativeId, kind: "ReviewedProductInitiative", projectId, initiativeHash: initiative.initiativeHash, initiativeCandidateId: initiative.initiativeCandidateId, reviewDecisionId: initiative.reviewDecisionId, title: initiative.title, description: initiative.description, reasoning: initiative.reasoning || "", featureResolution: initiative.featureResolution, epistemicClass: initiative.epistemicClass, sourceAuthority: initiative.authority, ...meta([initiative.initiativeId, initiative.initiativeCandidateId, initiative.reviewDecisionId], "reviewed", "reviewed-product-initiative") });
    add("PROMOTED_FROM", initiative.initiativeId, initiative.initiativeCandidateId, [initiative.initiativeId, initiative.initiativeCandidateId], "reviewed", "reviewed-product-initiative");
    add("PRODUCES", initiative.reviewDecisionId, initiative.initiativeId, [initiative.initiativeId, initiative.reviewDecisionId], "reviewed", "reviewed-product-initiative");
    const targetId = targetFor(initiative.featureResolution); if (targetId) add("PROPOSES_TO", initiative.initiativeId, targetId, [initiative.initiativeId, targetId], "reviewed", "reviewed-product-initiative");
  }
  for (const outcome of projection.outcomeObservations) {
    if (!nodeById.has(outcome.changeSetId)) fail("OutcomeObservation ChangeSet is absent from the graph.", "PRODUCT_OPERATING_CHANGE_SET_MISSING");
    pushNode({ nodeId: outcome.outcomeObservationId, kind: "OutcomeObservation", projectId, outcomeObservationHash: outcome.outcomeObservationHash, initiativeId: outcome.initiativeId, changeSetId: outcome.changeSetId, resultPacketId: outcome.resultPacketId, executionReviewDecisionId: outcome.executionReviewDecisionId, statement: outcome.statement, epistemicClass: outcome.epistemicClass, sourceAuthority: outcome.authority, ...meta([outcome.outcomeObservationId, outcome.changeSetId, outcome.resultPacketId, outcome.executionReviewDecisionId, ...outcome.evidenceIds], outcome.epistemicClass === "observed-fact" ? "runtime-observed" : "derived", "product-outcome-observation") });
    add("OBSERVES", outcome.outcomeObservationId, outcome.changeSetId, [outcome.outcomeObservationId, outcome.changeSetId], outcome.epistemicClass === "observed-fact" ? "runtime-observed" : "derived", "product-outcome-observation");
    if (outcome.initiativeId) add("OBSERVES", outcome.outcomeObservationId, outcome.initiativeId, [outcome.outcomeObservationId, outcome.initiativeId], outcome.epistemicClass === "observed-fact" ? "runtime-observed" : "derived", "product-outcome-observation");
  }
  return { productSignalCount: projection.signals.length, productHypothesisCount: projection.hypotheses.length, productInitiativeCandidateCount: projection.initiativeCandidates.length, productInitiativeReviewDecisionCount: projection.initiativeReviews.length, reviewedProductInitiativeCount: projection.reviewedInitiatives.length, productFeatureCandidateCount: projection.featureCandidates.length, outcomeObservationCount: projection.outcomeObservations.length };
}

function releaseObservationProjectionDescriptor(projection) {
  if (!projection) return {
    status: "not-provided", projectionInputId: null, projectionInputHash: null,
    branchStateObservationIds: [], deploymentResultObservationIds: [], releaseObservationIds: [],
  };
  return {
    status: "projected",
    projectionInputId: projection.projectionInputId,
    projectionInputHash: projection.projectionInputHash,
    branchStateObservationIds: projection.branchStates.map((item) => item.branchStateObservationId),
    deploymentResultObservationIds: projection.deploymentResults.map((item) => item.deploymentResultObservationId),
    releaseObservationIds: projection.releases.map((item) => item.releaseObservationId),
  };
}

function appendReleaseObservationProjection({ projectId, sourceSnapshotId, projection, nodes, edges, storage }) {
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  const empty = { branchStateObservationCount: 0, deploymentResultObservationCount: 0, releaseObservationCount: 0 };
  if (!projection) return empty;
  verifyReleaseObservationProjectionInput(projection);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const pushNode = (node) => { const existing = nodeById.get(node.nodeId); if (existing) return existing; nodeById.set(node.nodeId, node); nodes.push(node); return node; };
  const add = (type, from, to, evidenceIds) => edges.push(edgeRecord({ type, from, to, sourceSnapshotId, evidenceIds: [...new Set(evidenceIds)].sort(), authorityClass: "runtime-observed", origin: "release-observation" }));
  const ensureCommit = (observation) => pushNode({
    nodeId: observation.gitCommitObservationId,
    kind: "GitCommit",
    vcsKind: observation.vcsKind,
    gitCommitObservationHash: observation.gitCommitObservationHash,
    objectId: observation.objectId,
    parentObjectIds: observation.parents,
    authoredAt: observation.authoredAt,
    committedAt: observation.committedAt,
    authorName: observation.author.name,
    authorEmailDigest: observation.authorEmailDigest,
    refs: observation.refs,
    subject: observation.subject,
    body: observation.body,
    trustBoundary: observation.trustBoundary,
    sourceAuthority: observation.authority,
    ...nodeMetadata({ evidenceIds: [observation.objectId], sourceSnapshotId, authorityClass: "runtime-observed", origin: "release-git-observation", freshness: "historical" }),
  });
  for (const branch of projection.branchStates) {
    const commit = ensureCommit(branch.commitObservation);
    pushNode({
      nodeId: branch.branchStateObservationId,
      kind: "BranchStateObservation",
      projectId,
      branchStateObservationHash: branch.branchStateObservationHash,
      vcsKind: branch.vcsKind,
      ref: branch.ref,
      refKind: branch.refKind,
      commit: branch.commit,
      referencesDigest: branch.referencesDigest,
      sourceAuthority: branch.authority,
      ...nodeMetadata({ evidenceIds: [branch.branchStateObservationId, commit.nodeId], sourceSnapshotId, authorityClass: "runtime-observed", origin: "release-branch-state-observation", freshness: "historical" }),
    });
    add("AT_REVISION", branch.branchStateObservationId, commit.nodeId, [branch.branchStateObservationId, commit.nodeId]);
  }
  for (const deployment of projection.deploymentResults) pushNode({
    nodeId: deployment.deploymentResultObservationId,
    kind: "DeploymentResultObservation",
    projectId,
    deploymentResultObservationHash: deployment.deploymentResultObservationHash,
    environmentKey: deployment.environmentKey,
    status: deployment.status,
    commit: deployment.commit,
    observedAt: deployment.observedAt,
    sourceEventKeyDigest: deployment.sourceEventKeyDigest,
    deploymentEvidenceDigest: deployment.deploymentEvidenceDigest,
    approved: deployment.approved,
    approvalEvidenceDigest: deployment.approvalEvidenceDigest,
    changeSetId: deployment.changeSetId,
    vcsEvidenceId: deployment.vcsEvidenceId,
    sourceAuthority: deployment.authority,
    ...nodeMetadata({ evidenceIds: [deployment.deploymentResultObservationId, deployment.deploymentEvidenceDigest, deployment.approvalEvidenceDigest].filter(Boolean), sourceSnapshotId, authorityClass: "runtime-observed", origin: "deployment-result-observation", freshness: "historical" }),
  });
  for (const release of projection.releases) {
    pushNode({
      nodeId: release.releaseObservationId,
      kind: "ReleaseObservation",
      projectId,
      releaseObservationHash: release.releaseObservationHash,
      environmentKey: release.environmentKey,
      commit: release.commit,
      deploymentResultObservationId: release.deploymentResultObservationId,
      branchStateObservationIds: release.branchStateObservationIds,
      changeSetId: release.changeSetId,
      vcsEvidenceId: release.vcsEvidenceId,
      sourceAuthority: release.authority,
      ...nodeMetadata({ evidenceIds: [release.releaseObservationId, release.deploymentResultObservationId, ...release.branchStateObservationIds], sourceSnapshotId, authorityClass: "runtime-observed", origin: "release-observation", freshness: "historical" }),
    });
    const matchingCommit = projection.branchStates.find((item) => release.branchStateObservationIds.includes(item.branchStateObservationId))?.commitObservation;
    if (!matchingCommit) fail("ReleaseObservation commit evidence is missing.", "RELEASE_OBSERVATION_TEMPORAL_LINEAGE_MISSING");
    ensureCommit(matchingCommit);
    add("AT_REVISION", release.releaseObservationId, matchingCommit.gitCommitObservationId, [release.releaseObservationId, matchingCommit.gitCommitObservationId]);
    add("EVIDENCED_BY", release.releaseObservationId, release.deploymentResultObservationId, [release.releaseObservationId, release.deploymentResultObservationId]);
    for (const branchId of release.branchStateObservationIds) add("OBSERVED_ON", release.releaseObservationId, branchId, [release.releaseObservationId, branchId]);
    if (release.changeSetId) add("DEPLOYS", release.releaseObservationId, release.changeSetId, [release.releaseObservationId, release.changeSetId, release.vcsEvidenceId]);
  }
  return { branchStateObservationCount: projection.branchStates.length, deploymentResultObservationCount: projection.deploymentResults.length, releaseObservationCount: projection.releases.length, gitCommitObservationCount: nodes.filter((node) => node.kind === "GitCommit").length };
}

export function buildTemporalProvenanceGraph({
  projectId,
  storage = null,
  files,
  productModel = null,
  productEvidenceId = "",
  onboardingProjection = null,
  productPolicyProjection = null,
  featureMappingProjection = null,
  changeSetProjection = null,
  documentChangeProjection = null,
  observationProjection = null,
  productOperatingProjection = null,
  releaseObservationProjection = null,
  parentSourceSnapshotIds = [],
  revisionParentIds = {},
  logicalLineageState = {},
} = {}) {
  const format = formatForVerifiedOwner(storage);
  const { nodeMetadata, edgeRecord } = temporalRecordFactories(storage);
  if (typeof projectId !== "string" || !projectId.trim()) fail("projectId is required.", "TEMPORAL_PROJECT_ID_REQUIRED");
  if (!Array.isArray(files)) fail("files must be an array.", "TEMPORAL_FILES_REQUIRED");
  const selectedProductModel = productModel || normalizeProductModelDocument(emptyProductModelDocument(), format);
  const selectedOnboardingProjection = onboardingProjection ? verifyOnboardingGraphProjectionInput(onboardingProjection) : null;
  const selectedProductPolicyProjection = productPolicyProjection ? verifyProductPolicyProjectionInput(productPolicyProjection, projectId) : null;
  const selectedFeatureMappingProjection = featureMappingProjection ? verifyFeatureMappingProjectionInput(featureMappingProjection) : null;
  const selectedChangeSetProjection = changeSetProjection ? verifyChangeSetProjectionInput(changeSetProjection) : null;
  const selectedDocumentChangeProjection = documentChangeProjection ? verifyDocumentChangeProjectionInput(documentChangeProjection) : null;
  const selectedObservationProjection = observationProjection ? verifyObservationProjection(observationProjection, projectId) : null;
  const selectedProductOperatingProjection = productOperatingProjection ? verifyProductOperatingProjectionInput(productOperatingProjection) : null;
  const selectedReleaseObservationProjection = releaseObservationProjection ? verifyReleaseObservationProjectionInput(releaseObservationProjection) : null;
  if (selectedChangeSetProjection && selectedChangeSetProjection.projectId !== projectId) {
    fail("ChangeSet projection input does not match the temporal graph scope.", "CHANGE_SET_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedDocumentChangeProjection && selectedDocumentChangeProjection.projectId !== projectId) {
    fail("Document-change projection input does not match the temporal graph scope.", "DOCUMENT_CHANGE_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedObservationProjection && selectedObservationProjection.projectId !== projectId) {
    fail("Observation projection input does not match the temporal graph scope.", "OBSERVATION_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedProductOperatingProjection && selectedProductOperatingProjection.projectId !== projectId) {
    fail("Product operating projection input does not match the temporal graph scope.", "PRODUCT_OPERATING_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedReleaseObservationProjection && selectedReleaseObservationProjection.projectId !== projectId) {
    fail("Release observation projection input does not match the temporal graph scope.", "RELEASE_OBSERVATION_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedOnboardingProjection && (selectedOnboardingProjection.projectId !== projectId
    || selectedOnboardingProjection.currentProductModelId !== selectedProductModel.productModelId)) {
    fail("Onboarding projection input does not match the temporal graph scope.", "ONBOARDING_TEMPORAL_SCOPE_MISMATCH");
  }
  if (selectedFeatureMappingProjection && (selectedFeatureMappingProjection.projectId !== projectId
    || selectedFeatureMappingProjection.currentProductModelId !== selectedProductModel.productModelId)) {
    fail("Feature mapping projection input does not match the temporal graph scope.", "FEATURE_MAPPING_TEMPORAL_SCOPE_MISMATCH");
  }
  const selectedProductEvidenceId = productEvidenceId || identity("evidence", {
    kind: "product-canon",
    productModelHash: selectedProductModel.productModelHash,
  });
  const parents = normalizeParentSourceSnapshotIds(parentSourceSnapshotIds);
  const revisionParents = normalizeRevisionParentIds(revisionParentIds);
  const repositoryId = identity("repository", { projectId });
  const descriptors = temporalLogicalEntityDescriptors({ projectId, files, productModel: selectedProductModel });
  const lineageState = normalizeLogicalLineageState(logicalLineageState);
  const knownLogicalIdsForLineage = new Set(descriptors.logicalEntityIds);
  for (const logicalEntityId of lineageState.discontinuousLogicalEntityIds) if (!knownLogicalIdsForLineage.has(logicalEntityId)) {
    fail(`Discontinuous lineage references a non-current logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
  }
  for (const logicalEntityId of lineageState.continuityUnknownLogicalEntityIds) if (!knownLogicalIdsForLineage.has(logicalEntityId)
    && !lineageState.retiredLogicalEntityIds.includes(logicalEntityId)) {
    fail(`Unknown continuity references neither a current nor retired logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
  }
  for (const logicalEntityId of Object.keys(lineageState.continuityGenerationByLogicalEntityId)) {
    if (!knownLogicalIdsForLineage.has(logicalEntityId) && !lineageState.retiredLogicalEntityIds.includes(logicalEntityId)) {
      fail(`Continuity generation references neither a current nor retired logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
    }
  }
  const knownLogicalIds = new Set(descriptors.logicalEntityIds);
  const records = descriptors.fileDescriptors.map(({ file, fileId, symbolDescriptors, testId }) => {
    const fileParentRevisionIds = parentIdsFor(revisionParents, fileId, "file-revision");
    const fileRevisionId = identity("file-revision", {
      logicalEntityId: fileId,
      digest: file.digest,
      language: file.language || "text",
      classification: file.classification || "source",
      parentRevisionIds: fileParentRevisionIds,
    });
    const symbolRecords = symbolDescriptors.map(({ symbolId, name, symbolKind, occurrence, line, endLine, scopePath, qualifiedName, signature, identityAmbiguous, identitySignature, identityOccurrence }) => {
      const symbolParentRevisionIds = parentIdsFor(revisionParents, symbolId, "symbol-revision");
      const symbolRevisionId = identity("symbol-revision", {
        logicalEntityId: symbolId,
        fileRevisionId,
        line,
        parentRevisionIds: symbolParentRevisionIds,
      });
      return {
        symbolId,
        symbolRevisionId,
        symbolParentRevisionIds,
        name,
        symbolKind,
        occurrence,
        line,
        endLine,
        scopePath,
        qualifiedName,
        signature,
        identityAmbiguous,
        identitySignature,
        identityOccurrence,
      };
    });
    const testRecord = testId ? (() => {
      const testParentRevisionIds = parentIdsFor(revisionParents, testId, "test-revision");
      const testRevisionId = identity("test-revision", {
        logicalEntityId: testId,
        fileRevisionId,
        parentRevisionIds: testParentRevisionIds,
      });
      return { testId, testRevisionId, testParentRevisionIds };
    })() : null;
    return { file, fileId, fileRevisionId, fileParentRevisionIds, symbolRecords, testRecord, evidenceId: evidenceId(file) };
  });

  const productRecords = productRecordsFor({
    productDescriptors: descriptors.productDescriptors,
    productEvidenceId: selectedProductEvidenceId,
    revisionParents,
  });

  for (const logicalEntityId of Object.keys(revisionParents)) {
    if (!knownLogicalIds.has(logicalEntityId)) {
      fail(`Revision parents reference an unknown logical entity: ${logicalEntityId}`, "UNKNOWN_REVISION_PARENT_ENTITY");
    }
  }

  const fileRevisionIds = records.map((record) => record.fileRevisionId).sort();
  const symbolRevisionIds = records.flatMap((record) => record.symbolRecords.map((symbol) => symbol.symbolRevisionId)).sort();
  const testRevisionIds = records.flatMap((record) => record.testRecord ? [record.testRecord.testRevisionId] : []).sort();
  const productRevisionIds = productRecords.map((record) => record.revisionId).sort();
  const stateDigest = digest(canonicalJson({ projectId, fileRevisionIds, symbolRevisionIds, testRevisionIds, productRevisionIds, productModelId: selectedProductModel.productModelId, producerVersion: TEMPORAL_PROVENANCE_VERSION }));
  const sourceSnapshotId = identity("source-snapshot", {
    projectId,
    parentSnapshotIds: parents,
    fileRevisionIds,
    symbolRevisionIds,
    testRevisionIds,
    productRevisionIds,
    productModelId: selectedProductModel.productModelId,
    stateDigest,
    producerVersion: TEMPORAL_PROVENANCE_VERSION,
  });
  if (parents.includes(sourceSnapshotId)) fail("A SourceSnapshot cannot parent itself.", "TEMPORAL_SOURCE_CYCLE");

  const nodes = [];
  const edges = [];
  const allEvidenceIds = [...records.map((record) => record.evidenceId), selectedProductEvidenceId].sort();
  nodes.push({
    nodeId: sourceSnapshotId,
    kind: "SourceSnapshot",
    projectId,
    parentSnapshotIds: parents,
    fileRevisionIds,
    symbolRevisionIds,
    testRevisionIds,
    productRevisionIds,
    productModelId: selectedProductModel.productModelId,
    productModelSchemaVersion: selectedProductModel.schemaVersion,
    stateDigest,
    ...nodeMetadata({ evidenceIds: allEvidenceIds }),
  });
  nodes.push({
    nodeId: repositoryId,
    kind: "Repository",
    projectId,
    ...nodeMetadata({ evidenceIds: allEvidenceIds, sourceSnapshotId }),
  });

  for (const parentSnapshotId of parents) {
    nodes.push({
      nodeId: parentSnapshotId,
      kind: "SourceSnapshotReference",
      referencedSourceSnapshotId: parentSnapshotId,
      ...nodeMetadata({ evidenceIds: [identity("evidence", { kind: "declared-parent", parentSnapshotId })], sourceSnapshotId, origin: "declared-parent" }),
    });
    edges.push(edgeRecord({
      type: "PARENT_OF",
      from: parentSnapshotId,
      to: sourceSnapshotId,
      sourceSnapshotId,
      evidenceIds: [identity("evidence", { kind: "declared-parent", parentSnapshotId })],
      origin: "declared-parent",
    }));
  }

  const revisionReferences = new Map();
  const addRevisionParents = (logicalEntityId, revisionId, parentRevisionIds, revisionKind, evidenceIds, authorityClass = "derived") => {
    for (const parentRevisionId of parentRevisionIds) {
      if (parentRevisionId === revisionId) fail("A revision cannot parent itself.", "TEMPORAL_REVISION_CYCLE");
      const existing = revisionReferences.get(parentRevisionId);
      if (existing && (existing.logicalEntityId !== logicalEntityId || existing.revisionKind !== revisionKind)) {
        fail(`Revision parent identity is associated with conflicting logical entities: ${parentRevisionId}`, "REVISION_PARENT_IDENTITY_CONFLICT");
      }
      if (!existing) revisionReferences.set(parentRevisionId, { logicalEntityId, revisionKind, evidenceIds, authorityClass });
      edges.push(edgeRecord({ type: "PARENT_OF", from: parentRevisionId, to: revisionId, sourceSnapshotId, evidenceIds, origin: "declared-parent", authorityClass }));
    }
  };

  for (const record of records) {
    const { file, fileId, fileRevisionId, fileParentRevisionIds, symbolRecords, testRecord } = record;
    const evidenceIds = [record.evidenceId];
    nodes.push({
      nodeId: fileId,
      kind: "File",
      projectId,
      path: file.path,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId }),
    });
    nodes.push({
      nodeId: fileRevisionId,
      kind: "FileRevision",
      logicalEntityId: fileId,
      path: file.path,
      digest: file.digest,
      language: file.language || "text",
      classification: file.classification || "source",
      parentRevisionIds: fileParentRevisionIds,
      ...nodeMetadata({ evidenceIds, sourceSnapshotId }),
    });
    edges.push(edgeRecord({ type: "CONTAINS", from: repositoryId, to: fileId, sourceSnapshotId, evidenceIds }));
    edges.push(edgeRecord({ type: "CONTAINS", from: sourceSnapshotId, to: fileRevisionId, sourceSnapshotId, evidenceIds }));
    edges.push(edgeRecord({ type: "HAS_REVISION", from: fileId, to: fileRevisionId, sourceSnapshotId, evidenceIds }));
    edges.push(edgeRecord({ type: "CURRENT_REVISION", from: fileId, to: fileRevisionId, sourceSnapshotId, evidenceIds }));
    addRevisionParents(fileId, fileRevisionId, fileParentRevisionIds, "FileRevision", evidenceIds);

    for (const symbol of symbolRecords) {
      nodes.push({
        nodeId: symbol.symbolId,
        kind: "Symbol",
        fileId,
        path: file.path,
        name: symbol.name,
        symbolKind: symbol.symbolKind,
        occurrence: symbol.occurrence,
        scopePath: symbol.scopePath,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        identityAmbiguous: symbol.identityAmbiguous,
        identitySignature: symbol.identitySignature,
        identityOccurrence: symbol.identityOccurrence,
        identityBasis: "qualified-declaration",
        ...nodeMetadata({ evidenceIds, sourceSnapshotId, authorityClass: "heuristic", origin: "heuristic-symbol-scan", confidence: 0.6 }),
      });
      nodes.push({
        nodeId: symbol.symbolRevisionId,
        kind: "SymbolRevision",
        logicalEntityId: symbol.symbolId,
        fileRevisionId,
        path: file.path,
        name: symbol.name,
        symbolKind: symbol.symbolKind,
        occurrence: symbol.occurrence,
        line: symbol.line,
        endLine: symbol.endLine,
        scopePath: symbol.scopePath,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        identityAmbiguous: symbol.identityAmbiguous,
        identitySignature: symbol.identitySignature,
        identityOccurrence: symbol.identityOccurrence,
        identityBasis: "qualified-declaration",
        parentRevisionIds: symbol.symbolParentRevisionIds,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId, authorityClass: "heuristic", origin: "heuristic-symbol-scan", confidence: 0.6 }),
      });
      edges.push(edgeRecord({ type: "HAS_REVISION", from: symbol.symbolId, to: symbol.symbolRevisionId, sourceSnapshotId, evidenceIds, authorityClass: "heuristic", origin: "heuristic-symbol-scan", confidence: 0.6 }));
      edges.push(edgeRecord({ type: "CURRENT_REVISION", from: symbol.symbolId, to: symbol.symbolRevisionId, sourceSnapshotId, evidenceIds, authorityClass: "heuristic", origin: "heuristic-symbol-scan", confidence: 0.6 }));
      edges.push(edgeRecord({ type: "DECLARES", from: fileRevisionId, to: symbol.symbolRevisionId, sourceSnapshotId, evidenceIds, authorityClass: "heuristic", origin: "heuristic-symbol-scan", confidence: 0.6 }));
      addRevisionParents(symbol.symbolId, symbol.symbolRevisionId, symbol.symbolParentRevisionIds, "SymbolRevision", evidenceIds);
    }

    if (testRecord) {
      nodes.push({
        nodeId: testRecord.testId,
        kind: "Test",
        projectId,
        path: file.path,
        fileId,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId }),
      });
      nodes.push({
        nodeId: testRecord.testRevisionId,
        kind: "TestRevision",
        logicalEntityId: testRecord.testId,
        fileRevisionId,
        path: file.path,
        parentRevisionIds: testRecord.testParentRevisionIds,
        ...nodeMetadata({ evidenceIds, sourceSnapshotId }),
      });
      edges.push(edgeRecord({ type: "CONTAINS", from: repositoryId, to: testRecord.testId, sourceSnapshotId, evidenceIds }));
      edges.push(edgeRecord({ type: "HAS_REVISION", from: testRecord.testId, to: testRecord.testRevisionId, sourceSnapshotId, evidenceIds }));
      edges.push(edgeRecord({ type: "CURRENT_REVISION", from: testRecord.testId, to: testRecord.testRevisionId, sourceSnapshotId, evidenceIds }));
      edges.push(edgeRecord({ type: "REFERENCES", from: testRecord.testRevisionId, to: fileRevisionId, sourceSnapshotId, evidenceIds }));
      addRevisionParents(testRecord.testId, testRecord.testRevisionId, testRecord.testParentRevisionIds, "TestRevision", evidenceIds);
    }
  }

  const productByKindAndKey = new Map(productRecords.map((record) => [`${record.kind}:${record.key}`, record]));
  for (const record of productRecords) {
    nodes.push({
      nodeId: record.logicalEntityId,
      kind: record.kind,
      projectId,
      key: record.key,
      ...nodeMetadata({
        evidenceIds: record.evidenceIds,
        sourceSnapshotId,
        authorityClass: "canon-projected",
        origin: "project-product-canon",
      }),
    });
    nodes.push({
      nodeId: record.revisionId,
      kind: record.revisionKind,
      logicalEntityId: record.logicalEntityId,
      key: record.key,
      semantic: record.semantic,
      parentRevisionIds: record.parentRevisionIds,
      ...nodeMetadata({
        evidenceIds: record.evidenceIds,
        sourceSnapshotId,
        authorityClass: "canon-projected",
        origin: "project-product-canon",
      }),
    });
    edges.push(edgeRecord({ type: "CONTAINS", from: sourceSnapshotId, to: record.revisionId, sourceSnapshotId, evidenceIds: record.evidenceIds, authorityClass: "canon-projected", origin: "project-product-canon" }));
    edges.push(edgeRecord({ type: "HAS_REVISION", from: record.logicalEntityId, to: record.revisionId, sourceSnapshotId, evidenceIds: record.evidenceIds, authorityClass: "canon-projected", origin: "project-product-canon" }));
    edges.push(edgeRecord({ type: "CURRENT_REVISION", from: record.logicalEntityId, to: record.revisionId, sourceSnapshotId, evidenceIds: record.evidenceIds, authorityClass: "canon-projected", origin: "project-product-canon" }));
    addRevisionParents(record.logicalEntityId, record.revisionId, record.parentRevisionIds, record.revisionKind, record.evidenceIds, "canon-projected");
  }

  const productRelation = (type, from, to) => edges.push(edgeRecord({
    type,
    from,
    to,
    sourceSnapshotId,
    evidenceIds: [selectedProductEvidenceId],
    authorityClass: "canon-projected",
    origin: "project-product-canon",
  }));
  for (const record of productRecords) {
    if (record.kind === "FeatureGroup") {
      for (const parentKey of record.semantic.parentFeatureGroupKeys) {
        productRelation("CONTAINS", productByKindAndKey.get(`FeatureGroup:${parentKey}`).logicalEntityId, record.logicalEntityId);
      }
    }
    if (record.kind === "Policy") {
      if (record.semantic.status === "active") for (const application of record.semantic.appliesTo) {
        productRelation("GOVERNED_BY", productByKindAndKey.get(`${application.kind}:${application.key}`).logicalEntityId, record.logicalEntityId);
      }
      for (const governed of record.semantic.governedBy) {
        productRelation("GOVERNED_BY", record.logicalEntityId, productByKindAndKey.get(`${governed.kind}:${governed.key}`).logicalEntityId);
      }
      continue;
    }
    if (record.kind !== "Feature") continue;
    for (const groupKey of record.semantic.featureGroupKeys) {
      productRelation("CONTAINS", productByKindAndKey.get(`FeatureGroup:${groupKey}`).logicalEntityId, record.logicalEntityId);
    }
    for (const capabilityKey of record.semantic.capabilityKeys) {
      productRelation("REALIZES", record.logicalEntityId, productByKindAndKey.get(`Capability:${capabilityKey}`).logicalEntityId);
    }
    for (const governed of record.semantic.governedBy) {
      productRelation("GOVERNED_BY", record.logicalEntityId, productByKindAndKey.get(`${governed.kind}:${governed.key}`).logicalEntityId);
    }
  }

  for (const [parentRevisionId, reference] of revisionReferences) {
    nodes.push({
      nodeId: parentRevisionId,
      kind: "RevisionReference",
      referencedRevisionId: parentRevisionId,
      revisionKind: reference.revisionKind,
      logicalEntityId: reference.logicalEntityId,
      ...nodeMetadata({ evidenceIds: reference.evidenceIds, sourceSnapshotId, origin: "declared-parent", authorityClass: reference.authorityClass }),
    });
  }

  const onboardingSummary = appendOnboardingProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedOnboardingProjection,
    nodes,
    edges,
  });
  const productPolicySummary = appendProductPolicyProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedProductPolicyProjection,
    nodes,
    edges,
  });
  const featureMappingSummary = appendFeatureMappingProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedFeatureMappingProjection,
    nodes,
    edges,
    continuityGenerationByLogicalEntityId: lineageState.continuityGenerationByLogicalEntityId,
    continuityUnknownLogicalEntityIds: new Set(lineageState.continuityUnknownLogicalEntityIds),
  });
  const changeSetSummary = appendChangeSetProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedChangeSetProjection,
    nodes,
    edges,
  });
  const documentChangeSummary = appendDocumentChangeProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedDocumentChangeProjection,
    nodes,
    edges,
  });
  const observationSummary = appendObservationProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedObservationProjection,
    nodes,
    edges,
  });
  const productOperatingSummary = appendProductOperatingProjection({
    storage,
    projectId,
    productModelId: selectedProductModel.productModelId,
    sourceSnapshotId,
    projection: selectedProductOperatingProjection,
    nodes,
    edges,
  });
  const releaseObservationSummary = appendReleaseObservationProjection({
    storage,
    projectId,
    sourceSnapshotId,
    projection: selectedReleaseObservationProjection,
    nodes,
    edges,
  });

  deduplicateTemporalEdgesInPlace(edges);

  nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const summary = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    fileCount: nodes.filter((node) => node.kind === "File").length,
    fileRevisionCount: nodes.filter((node) => node.kind === "FileRevision").length,
    symbolCount: nodes.filter((node) => node.kind === "Symbol").length,
    symbolRevisionCount: nodes.filter((node) => node.kind === "SymbolRevision").length,
    testCount: nodes.filter((node) => node.kind === "Test").length,
    testRevisionCount: nodes.filter((node) => node.kind === "TestRevision").length,
    featureGroupCount: nodes.filter((node) => node.kind === "FeatureGroup").length,
    capabilityCount: nodes.filter((node) => node.kind === "Capability").length,
    featureCount: nodes.filter((node) => node.kind === "Feature").length,
    requirementCount: nodes.filter((node) => node.kind === "Requirement").length,
    constraintCount: nodes.filter((node) => node.kind === "Constraint").length,
    decisionCount: nodes.filter((node) => node.kind === "Decision").length,
    policyCount: nodes.filter((node) => node.kind === "Policy").length,
    productRevisionCount: productRevisionIds.length,
    sourceParentCount: parents.length,
    revisionParentCount: Object.values(revisionParents).reduce((count, values) => count + values.length, 0),
    ...onboardingSummary,
    ...productPolicySummary,
    ...featureMappingSummary,
    ...changeSetSummary,
    ...documentChangeSummary,
    ...observationSummary,
    ...productOperatingSummary,
    ...releaseObservationSummary,
  };
  const payload = {
    kind: "GraphSnapshot",
    protocol: { name: format.protocol("head-agent-core-temporal-provenance"), version: TEMPORAL_PROVENANCE_VERSION },
    authority: "derived-evidence-only",
    authorityBoundary: artifactAuthorityBoundary("GraphSnapshot"),
    rebuildable: true,
    uniqueAuthority: false,
    projectId,
    productModelId: selectedProductModel.productModelId,
    productModelHash: selectedProductModel.productModelHash,
    productModelSchemaVersion: selectedProductModel.schemaVersion,
    onboardingProjection: onboardingProjectionDescriptor(selectedOnboardingProjection),
    productPolicyProjection: productPolicyProjectionDescriptor(selectedProductPolicyProjection),
    featureMappingProjection: featureMappingProjectionDescriptor(selectedFeatureMappingProjection),
    changeSetProjection: changeSetProjectionDescriptor(selectedChangeSetProjection),
    documentChangeProjection: documentChangeProjectionDescriptor(selectedDocumentChangeProjection),
    observationProjection: observationProjectionDescriptor(selectedObservationProjection),
    productOperatingProjection: productOperatingProjectionDescriptor(selectedProductOperatingProjection),
    releaseObservationProjection: releaseObservationProjectionDescriptor(selectedReleaseObservationProjection),
    sourceSnapshotId,
    parentSourceSnapshotIds: parents,
    revisionParentIds: revisionParents,
    logicalLineageState: lineageState,
    relationTypes: [...TEMPORAL_RELATION_TYPES],
    nodeKinds: [...TEMPORAL_NODE_KINDS],
    nodes,
    edges,
    summary,
  };
  const graphSnapshotHash = digest(canonicalJson(payload));
  const graph = { ...payload, graphSnapshotId: `graph-snapshot-${graphSnapshotHash.slice(0, 24)}`, graphSnapshotHash };
  return verifyTemporalProvenanceGraph(graph);
}

function requireMetadata(record, label, { sourceSnapshotRequired = true } = {}) {
  for (const field of ["authorityClass", "origin", "evidenceIds", "freshness", "producer", "producerVersion", "instructionAuthority", "promotionAuthority"]) {
    if (!(field in record)) fail(`${label} is missing ${field}.`, "TEMPORAL_PROVENANCE_MISSING");
  }
  if (sourceSnapshotRequired && !record.sourceSnapshotId) fail(`${label} is missing sourceSnapshotId.`, "TEMPORAL_PROVENANCE_MISSING");
  if (!AUTHORITY_CLASSES.has(record.authorityClass)) fail(`${label} has an invalid authorityClass.`, "INVALID_TEMPORAL_AUTHORITY");
  if (!FRESHNESS_STATES.has(record.freshness)) fail(`${label} has invalid freshness.`, "INVALID_TEMPORAL_FRESHNESS");
  if (!Array.isArray(record.evidenceIds) || canonicalJson(record.evidenceIds) !== canonicalJson([...new Set(record.evidenceIds)].sort())) {
    fail(`${label} evidenceIds must be sorted and unique.`, "INVALID_TEMPORAL_EVIDENCE");
  }
  if (typeof record.instructionAuthority !== "boolean" || typeof record.promotionAuthority !== "boolean") {
    fail(`${label} authority flags must be boolean.`, "INVALID_TEMPORAL_AUTHORITY");
  }
  if (record.instructionAuthority || record.promotionAuthority) {
    fail(`${label} cannot gain instruction or promotion authority from graph projection.`, "INVALID_TEMPORAL_AUTHORITY");
  }
  if (record.authorityClass === "heuristic" || record.origin.startsWith("heuristic")) {
    if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
      fail(`${label} requires confidence from zero through one.`, "INVALID_TEMPORAL_CONFIDENCE");
    }
  } else if (record.confidence != null && (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1)) {
    fail(`${label} has invalid confidence.`, "INVALID_TEMPORAL_CONFIDENCE");
  }
}

function expectedNodeId(node) {
  if (node.kind === "Repository") return identity("repository", { projectId: node.projectId });
  if (node.kind === "File") return identity("file", { projectId: node.projectId, path: node.path });
  if (node.kind === "FileRevision") return identity("file-revision", {
    logicalEntityId: node.logicalEntityId,
    digest: node.digest,
    language: node.language,
    classification: node.classification,
    parentRevisionIds: node.parentRevisionIds,
  });
  if (node.kind === "Symbol") return node.identityBasis === "qualified-declaration"
    ? identity("symbol", {
      fileId: node.fileId,
      symbolKind: node.symbolKind,
      qualifiedName: node.qualifiedName,
      signature: node.identitySignature,
      occurrence: node.identityOccurrence,
    })
    : identity("symbol", { fileId: node.fileId, symbolKind: node.symbolKind, name: node.name, occurrence: node.occurrence });
  if (node.kind === "SymbolRevision") return identity("symbol-revision", {
    logicalEntityId: node.logicalEntityId,
    fileRevisionId: node.fileRevisionId,
    line: node.line,
    parentRevisionIds: node.parentRevisionIds,
  });
  if (node.kind === "Test") return identity("test", { projectId: node.projectId, path: node.path });
  if (node.kind === "TestRevision") return identity("test-revision", {
    logicalEntityId: node.logicalEntityId,
    fileRevisionId: node.fileRevisionId,
    parentRevisionIds: node.parentRevisionIds,
  });
  const productDefinition = PRODUCT_DEFINITIONS[node.kind];
  if (productDefinition) return identity(productDefinition.prefix, { projectId: node.projectId, key: node.key });
  const productRevisionEntry = Object.entries(PRODUCT_DEFINITIONS).find(([kind]) => node.kind === `${kind}Revision`);
  if (productRevisionEntry) return identity(productRevisionEntry[1].revisionPrefix, {
    logicalEntityId: node.logicalEntityId,
    semantic: node.semantic,
    parentRevisionIds: node.parentRevisionIds,
  });
  if (node.kind === "SourceSnapshot") return identity("source-snapshot", {
    projectId: node.projectId,
    parentSnapshotIds: node.parentSnapshotIds,
    fileRevisionIds: node.fileRevisionIds,
    symbolRevisionIds: node.symbolRevisionIds,
    testRevisionIds: node.testRevisionIds,
    productRevisionIds: node.productRevisionIds,
    productModelId: node.productModelId,
    stateDigest: node.stateDigest,
    producerVersion: node.producerVersion,
  });
  if (node.kind === "SourceSnapshotReference") return node.referencedSourceSnapshotId;
  if (node.kind === "RevisionReference") return node.referencedRevisionId;
  if (node.kind === "OnboardingCandidateSet") return `onboarding-candidates-${String(node.candidateSetHash || "").slice(0, 24)}`;
  if (node.kind === "HistoricalOnboardingCandidateReference") return node.referencedCandidateSetId;
  if (node.kind === "OnboardingProductCandidate") return `onboarding-candidate-${String(node.candidateHash || "").slice(0, 24)}`;
  if (node.kind === "OnboardingEvidence") return `onboarding-evidence-${String(node.onboardingEvidenceHash || "").slice(0, 24)}`;
  if (node.kind === "OnboardingUnknown") return node.nodeId;
  if (node.kind === "OnboardingReviewDecision") return `onboarding-review-decision-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "ProductConceptReference") return identity("product-concept-reference", {
    projectId: node.projectId,
    productKind: node.productKind,
    key: node.key,
  });
  if (node.kind === "ProductModelRevision") return `product-model-${String(node.productModelHash || "").slice(0, 24)}`;
  if (node.kind === "ProductModelRevisionReference") return identity("product-model-revision-reference", {
    projectId: node.projectId,
    productModelId: node.referencedProductModelId,
    productModelHash: node.referencedProductModelHash,
  });
  if (node.kind === "ProductPolicyCandidate") return `policy-candidate-${String(node.candidateHash || "").slice(0, 24)}`;
  if (node.kind === "ProductPolicyEvidence") return identity("product-policy-evidence", {
    candidateId: node.candidateId,
    anchor: { kind: node.evidenceKind, reference: node.reference, digest: node.contentDigest, summary: node.summary },
  });
  if (node.kind === "ProductPolicyReviewDecision") return `review-decision-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "FeatureMappingCandidateSet") return `feature-mapping-candidates-${String(node.candidateSetHash || "").slice(0, 24)}`;
  if (node.kind === "FeatureMappingCandidate") return `feature-mapping-candidate-${String(node.candidateHash || "").slice(0, 24)}`;
  if (node.kind === "FeatureMappingEvidence") return `feature-mapping-evidence-${String(node.featureMappingEvidenceHash || "").slice(0, 24)}`;
  if (node.kind === "FeatureMappingUnknown") return node.nodeId;
  if (node.kind === "FeatureMappingReviewDecision") return `feature-mapping-review-decision-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "ReviewedRelationship") return identity("reviewed-relationship", {
    projectId: node.projectId,
    reviewDecisionId: node.reviewDecisionId,
    candidateId: node.candidateId,
    relationshipType: node.relationshipType,
    fromNodeId: node.fromNodeId,
    fromKind: node.fromKind,
    toNodeId: node.toNodeId,
    toKind: node.toKind,
    evidenceSourceSnapshotId: node.evidenceSourceSnapshotId,
    productModelId: node.productModelId,
  });
  if (node.kind === "MappingEndpointReference") return node.referencedNodeId;
  if (node.kind === "ChangeSet") return `change-set-${String(node.changeSetHash || "").slice(0, 24)}`;
  if (node.kind === "ChangeRevisionReference") return identity("change-revision-reference", {
    changeSetId: node.changeSetId,
    changeId: node.changeId,
    role: node.role,
    revisionId: node.referencedRevisionId,
  });
  if (node.kind === "ExecutionLineageReference") return node.referencedArtifactId;
  if (node.kind === "ChangeImpactCandidateSet") return `change-impact-candidates-${String(node.candidateSetHash || "").slice(0, 24)}`;
  if (node.kind === "ChangeImpactCandidate") return `change-impact-candidate-${String(node.candidateHash || "").slice(0, 24)}`;
  if (node.kind === "ChangeImpactUnknown") return node.nodeId;
  if (node.kind === "ChangeImpactReviewDecision") return `change-impact-review-decision-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "ReviewedImpact") return identity("reviewed-impact", {
    projectId: node.projectId,
    reviewDecisionId: node.reviewDecisionId,
    candidateId: node.candidateId,
    changeSetId: node.changeSetId,
    targetNodeId: node.targetNodeId,
    targetKind: node.targetKind,
    targetRevisionId: node.targetRevisionId,
  });
  if (node.kind === "ChangeProductReference") return node.referencedNodeId;
  if (node.kind === "VcsEvidence") return `vcs-evidence-${String(node.vcsEvidenceHash || "").slice(0, 24)}`;
  if (node.kind === "GitCommit") return `git-commit-observation-${String(node.gitCommitObservationHash || "").slice(0, 24)}`;
  if (node.kind === "DocumentChangeCandidateSet") return node.nodeId;
  if (node.kind === "DocumentChangeCandidate") return node.nodeId;
  if (node.kind === "DocumentChangeReviewDecision") return `document-change-review-decision-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "DocumentChangeApplication") return `document-change-application-${String(node.applicationReceiptHash || "").slice(0, 24)}`;
  if (node.kind === "DocumentProductModelRevision") return `document-product-model-revision-${String(node.revisionHash || "").slice(0, 24)}`;
  if (node.kind === "DocumentProjectionReference") return identity("document-projection-reference", {
    projectId: node.projectId,
    documentProjectionId: node.documentProjectionId,
    documentProjectionHash: node.documentProjectionHash,
    graphSnapshotId: node.graphSnapshotId,
    graphSnapshotHash: node.graphSnapshotHash,
    referencedSourceSnapshotId: node.referencedSourceSnapshotId,
  });
  if (node.kind === "ProductSignal") return `product-signal-${String(node.signalHash || "").slice(0, 24)}`;
  if (node.kind === "ProductHypothesis") return `product-hypothesis-${String(node.hypothesisHash || "").slice(0, 24)}`;
  if (node.kind === "ProductInitiativeCandidate") return `product-initiative-candidate-${String(node.initiativeCandidateHash || "").slice(0, 24)}`;
  if (node.kind === "ProductInitiativeReviewDecision") return `product-initiative-review-${String(node.reviewDecisionHash || "").slice(0, 24)}`;
  if (node.kind === "ReviewedProductInitiative") return `reviewed-product-initiative-${String(node.initiativeHash || "").slice(0, 24)}`;
  if (node.kind === "ProductFeatureCandidate") return `product-feature-candidate-${String(node.featureCandidateHash || "").slice(0, 24)}`;
  if (node.kind === "ProductFeatureReference") return identity("product-feature-reference", { projectId: node.projectId, featureKey: node.featureKey, productModelId: node.referencedProductModelId });
  if (node.kind === "OutcomeObservation") return `outcome-observation-${String(node.outcomeObservationHash || "").slice(0, 24)}`;
  if (node.kind === "BranchStateObservation") return `branch-state-observation-${String(node.branchStateObservationHash || "").slice(0, 24)}`;
  if (node.kind === "DeploymentResultObservation") return `deployment-result-observation-${String(node.deploymentResultObservationHash || "").slice(0, 24)}`;
  if (node.kind === "ReleaseObservation") return `release-observation-${String(node.releaseObservationHash || "").slice(0, 24)}`;
  if (node.kind === "ObservationTypeDescriptor") return `observation-type-${String(node.descriptorHash || "").slice(0, 24)}`;
  if (node.kind === "ObservationCollectionReceipt") return `observation-receipt-${String(node.receiptHash || "").slice(0, 24)}`;
  if (node.kind === "ObservationRecord") return `observation-${String(node.observationHash || "").slice(0, 24)}`;
  if (node.kind === "DerivedObservationRecord") return `derived-observation-${String(node.derivedObservationHash || "").slice(0, 24)}`;
  return "";
}

function validEndpointKinds(type, fromKind, toKind) {
  const productKinds = Object.keys(PRODUCT_DEFINITIONS);
  const productRevisionKinds = productKinds.map((kind) => `${kind}Revision`);
  if (type === "CONTAINS") return (fromKind === "Repository" && ["File", "Test"].includes(toKind))
    || (fromKind === "SourceSnapshot" && ["FileRevision", ...productRevisionKinds].includes(toKind))
    || (fromKind === "FeatureGroup" && ["FeatureGroup", "Feature"].includes(toKind))
    || (fromKind === "OnboardingCandidateSet" && ["OnboardingProductCandidate", "OnboardingEvidence", "OnboardingUnknown"].includes(toKind))
    || (fromKind === "FeatureMappingCandidateSet" && ["FeatureMappingCandidate", "FeatureMappingEvidence", "FeatureMappingUnknown"].includes(toKind))
    || (fromKind === "ChangeImpactCandidateSet" && ["ChangeImpactCandidate", "ChangeImpactUnknown"].includes(toKind))
    || (fromKind === "DocumentChangeCandidateSet" && toKind === "DocumentChangeCandidate");
  if (["HAS_REVISION", "CURRENT_REVISION"].includes(type)) return (fromKind === "File" && toKind === "FileRevision")
    || (fromKind === "Symbol" && toKind === "SymbolRevision") || (fromKind === "Test" && toKind === "TestRevision")
    || productKinds.some((kind) => fromKind === kind && toKind === `${kind}Revision`);
  if (type === "PARENT_OF") return (["SourceSnapshot", "SourceSnapshotReference"].includes(fromKind) && toKind === "SourceSnapshot")
    || (fromKind === "RevisionReference" && ["FileRevision", "SymbolRevision", "TestRevision", ...productRevisionKinds].includes(toKind))
    || (fromKind === "OnboardingCandidateSet" && toKind === "OnboardingCandidateSet")
    || (fromKind === "ProductModelRevision" && toKind === "ProductModelRevision");
  if (type === "DECLARES") return fromKind === "FileRevision" && toKind === "SymbolRevision";
  if (type === "REFERENCES") return (fromKind === "TestRevision" && toKind === "FileRevision")
    || (fromKind === "ProductHypothesis" && ["ProductSignal", "ObservationRecord", "DerivedObservationRecord"].includes(toKind))
    || (fromKind === "VcsEvidence" && toKind === "GitCommit")
    || (fromKind === "ChangeRevisionReference" && ["FileRevision", "SymbolRevision", "TestRevision", "RevisionReference"].includes(toKind))
    || (fromKind === "ProductModelRevisionReference" && toKind === "PolicyRevision");
  if (type === "REALIZES") return fromKind === "Feature" && toKind === "Capability";
  if (type === "GOVERNED_BY") return (fromKind === "Feature" && ["Requirement", "Constraint", "Decision", "Policy"].includes(toKind))
    || (fromKind === "Policy" && ["Requirement", "Constraint", "Decision"].includes(toKind))
    || (fromKind === "FeatureGroup" && toKind === "Policy");
  if (type === "PROPOSES_FROM") return (fromKind === "OnboardingCandidateSet" && ["SourceSnapshot", "SourceSnapshotReference"].includes(toKind))
    || (fromKind === "FeatureMappingCandidate" && ["File", "Symbol", "Feature", "Capability", "MappingEndpointReference"].includes(toKind))
    || (fromKind === "DocumentChangeCandidateSet" && toKind === "DocumentProjectionReference")
    || (fromKind === "ProductInitiativeCandidate" && toKind === "ProductHypothesis")
    || (fromKind === "ProductPolicyCandidate" && toKind === "ProductModelRevisionReference");
  if (type === "PROPOSES_TO") return (fromKind === "OnboardingProductCandidate" && toKind === "ProductConceptReference")
    || (fromKind === "FeatureMappingCandidate" && ["Feature", "Capability", "Test", "MappingEndpointReference"].includes(toKind))
    || (fromKind === "ChangeImpactCandidate" && ["Feature", "Capability", "ChangeProductReference"].includes(toKind))
    || (["ProductInitiativeCandidate", "ReviewedProductInitiative"].includes(fromKind) && ["Feature", "ProductFeatureCandidate", "ProductFeatureReference"].includes(toKind))
    || (fromKind === "ProductPolicyCandidate" && toKind === "ProductModelRevisionReference");
  if (type === "SUPPORTED_BY") return (fromKind === "OnboardingProductCandidate" && toKind === "OnboardingEvidence")
    || (fromKind === "FeatureMappingCandidate" && toKind === "FeatureMappingEvidence")
    || (fromKind === "ChangeSet" && toKind === "ExecutionLineageReference")
    || (fromKind === "ChangeImpactCandidate" && toKind === "ChangeSet")
    || (fromKind === "ProductHypothesis" && ["ProductSignal", "ObservationRecord", "DerivedObservationRecord"].includes(toKind))
    || (fromKind === "ProductPolicyCandidate" && toKind === "ProductPolicyEvidence");
  if (type === "REVIEWED_BY") return (fromKind === "OnboardingCandidateSet" && toKind === "OnboardingReviewDecision")
    || (fromKind === "FeatureMappingCandidateSet" && toKind === "FeatureMappingReviewDecision")
    || (fromKind === "ChangeSet" && toKind === "ExecutionLineageReference")
    || (fromKind === "ChangeImpactCandidateSet" && toKind === "ChangeImpactReviewDecision")
    || (fromKind === "DocumentChangeCandidateSet" && toKind === "DocumentChangeReviewDecision")
    || (fromKind === "ProductInitiativeCandidate" && toKind === "ProductInitiativeReviewDecision")
    || (fromKind === "ProductPolicyCandidate" && toKind === "ProductPolicyReviewDecision");
  if (["ACCEPTED_BY", "REJECTED_BY"].includes(type)) return (fromKind === "OnboardingProductCandidate" && toKind === "OnboardingReviewDecision")
    || (fromKind === "FeatureMappingCandidate" && toKind === "FeatureMappingReviewDecision")
    || (fromKind === "ChangeImpactCandidate" && toKind === "ChangeImpactReviewDecision")
    || (fromKind === "DocumentChangeCandidate" && toKind === "DocumentChangeReviewDecision")
    || (fromKind === "ProductInitiativeCandidate" && toKind === "ProductInitiativeReviewDecision")
    || (fromKind === "ProductPolicyCandidate" && toKind === "ProductPolicyReviewDecision");
  if (type === "PROMOTED_FROM") return (fromKind === "ProductModelRevision" && toKind === "OnboardingProductCandidate")
    || (fromKind === "ReviewedRelationship" && toKind === "FeatureMappingCandidate")
    || (fromKind === "ReviewedImpact" && toKind === "ChangeImpactCandidate")
    || (fromKind === "DocumentProductModelRevision" && toKind === "DocumentChangeCandidate")
    || (fromKind === "ReviewedProductInitiative" && toKind === "ProductInitiativeCandidate");
  if (type === "PRODUCES") return (fromKind === "OnboardingReviewDecision" && ["OnboardingCandidateSet", "ProductModelRevision"].includes(toKind))
    || (fromKind === "FeatureMappingReviewDecision" && toKind === "ReviewedRelationship")
    || (fromKind === "ChangeImpactReviewDecision" && toKind === "ReviewedImpact")
    || (fromKind === "DocumentChangeReviewDecision" && ["DocumentProductModelRevision", "DocumentChangeApplication"].includes(toKind))
    || (fromKind === "DocumentChangeApplication" && toKind === "DocumentProjectionReference")
    || (fromKind === "ProductInitiativeReviewDecision" && toKind === "ReviewedProductInitiative")
    || (fromKind === "ProductPolicyReviewDecision" && ["ProductModelRevisionReference", "PolicyRevision"].includes(toKind));
  if (type === "IMPLEMENTS") return ["File", "Symbol"].includes(fromKind) && ["Feature", "Capability"].includes(toKind);
  if (type === "VERIFIED_BY") return ["Feature", "Capability"].includes(fromKind) && toKind === "Test";
  if (type === "CHANGES") return fromKind === "ChangeSet" && toKind === "ChangeRevisionReference";
  if (type === "IMPACTS") return fromKind === "ChangeSet" && ["Feature", "Capability"].includes(toKind);
  if (type === "SUPERSEDES") return (fromKind === "ChangeSet" && toKind === "ChangeSet")
    || (fromKind === "ChangeRevisionReference" && toKind === "ChangeRevisionReference");
  if (type === "MATERIALIZED_AS") return fromKind === "ChangeSet" && toKind === "VcsEvidence";
  if (type === "OBSERVES") return fromKind === "OutcomeObservation" && ["ChangeSet", "ReviewedProductInitiative"].includes(toKind);
  if (type === "AT_REVISION") return (["BranchStateObservation", "ReleaseObservation"].includes(fromKind) && toKind === "GitCommit")
    || (fromKind === "ReviewedImpact" && ["FeatureRevision", "CapabilityRevision"].includes(toKind))
    || (fromKind === "ObservationRecord" && ["FileRevision", "RevisionReference"].includes(toKind));
  if (type === "OBSERVED_ON") return fromKind === "ReleaseObservation" && toKind === "BranchStateObservation";
  if (type === "EVIDENCED_BY") return (fromKind === "ReleaseObservation" && toKind === "DeploymentResultObservation")
    || (fromKind === "ObservationRecord" && toKind === "ObservationCollectionReceipt");
  if (type === "DEPLOYS") return fromKind === "ReleaseObservation" && toKind === "ChangeSet";
  if (type === "CONFORMS_TO") return ["ObservationRecord", "DerivedObservationRecord"].includes(fromKind) && toKind === "ObservationTypeDescriptor";
  if (type === "DERIVED_FROM") return fromKind === "DerivedObservationRecord" && toKind === "ObservationRecord";
  if (type === "HISTORICALLY_FOLLOWS") return fromKind === "HistoricalOnboardingCandidateReference" && toKind === "OnboardingCandidateSet";
  return false;
}

export function verifyTemporalProvenanceGraph(graph) {
  const owned = ownedTemporalGraphs.get(graph);
  if (owned?.state.active && owned.verified) return graph;
  const format = familyFormatForOriginal("head-agent-core-temporal-provenance", graph);
  const graphVersion = graph?.protocol?.version;
  const legacyV02 = graphVersion === "0.2.0";
  const legacyV03 = graphVersion === "0.3.0";
  const legacyV04 = graphVersion === "0.4.0";
  const legacyV05 = graphVersion === "0.5.0";
  const legacyV06 = graphVersion === "0.6.0";
  const legacyV07 = graphVersion === "0.7.0";
  const legacyV08 = graphVersion === "0.8.0";
  const legacyV09 = graphVersion === "0.9.0";
  const legacyV10 = graphVersion === "0.10.0";
  const legacyV11 = graphVersion === "0.11.0";
  const legacyV12 = graphVersion === "0.12.0";
  const legacyV13 = graphVersion === "0.13.0";
  const legacyV14 = graphVersion === "0.14.0";
  if (!graph || graph.kind !== "GraphSnapshot" || !format
    || !new Set(["0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0", "0.9.0", "0.10.0", "0.11.0", "0.12.0", "0.13.0", "0.14.0", TEMPORAL_PROVENANCE_VERSION]).has(graphVersion)) {
    fail("Temporal provenance GraphSnapshot is invalid.", "INVALID_TEMPORAL_PROVENANCE_GRAPH");
  }
  if (graph.authority !== "derived-evidence-only" || graph.rebuildable !== true || graph.uniqueAuthority !== false) {
    fail("Temporal provenance graph cannot claim canonical or unique authority.", "INVALID_TEMPORAL_GRAPH_AUTHORITY");
  }
  if (legacyV09 || legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) verifyArtifactAuthorityBoundary("GraphSnapshot", graph.authorityBoundary);
  if (!/^product-model-[a-f0-9]{24}$/.test(graph.productModelId || "") || !/^[a-f0-9]{64}$/.test(graph.productModelHash || "")) {
    fail("Temporal graph product model identity is invalid.", "INVALID_TEMPORAL_PRODUCT_MODEL");
  }
  if ((legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) && ![1, 2].includes(graph.productModelSchemaVersion)) {
    fail("Temporal graph product model schema version is invalid.", "INVALID_TEMPORAL_PRODUCT_MODEL");
  }
  const payload = { ...graph };
  delete payload.graphSnapshotId;
  delete payload.graphSnapshotHash;
  const actualHash = digest(canonicalJson(payload));
  if (graph.graphSnapshotHash !== actualHash || graph.graphSnapshotId !== `graph-snapshot-${actualHash.slice(0, 24)}`) {
    fail("Temporal provenance graph digest verification failed.", "TEMPORAL_GRAPH_DIGEST_MISMATCH");
  }
  if (canonicalJson(graph.parentSourceSnapshotIds) !== canonicalJson(normalizeParentSourceSnapshotIds(graph.parentSourceSnapshotIds))) {
    fail("SourceSnapshot parents must be sorted and unique.", "INVALID_SOURCE_SNAPSHOT_PARENT");
  }
  if (canonicalJson(graph.revisionParentIds) !== canonicalJson(normalizeRevisionParentIds(graph.revisionParentIds))) {
    fail("Revision parents must be normalized.", "INVALID_REVISION_PARENT_SET");
  }
  if ((legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION)
    && canonicalJson(graph.logicalLineageState) !== canonicalJson(normalizeLogicalLineageState(graph.logicalLineageState))) {
    fail("Logical lineage state must be normalized.", "INVALID_LOGICAL_LINEAGE_STATE");
  }
  const expectedRelationTypes = legacyV02 ? TEMPORAL_RELATION_TYPES_V02 : legacyV03 ? TEMPORAL_RELATION_TYPES_V03 : legacyV04 ? TEMPORAL_RELATION_TYPES_V04 : legacyV05 ? TEMPORAL_RELATION_TYPES_V05 : legacyV06 ? TEMPORAL_RELATION_TYPES_V06 : legacyV07 ? TEMPORAL_RELATION_TYPES_V07 : (legacyV08 || legacyV09 || legacyV10) ? TEMPORAL_RELATION_TYPES_V10 : legacyV11 ? TEMPORAL_RELATION_TYPES_V11 : (legacyV12 || legacyV13 || legacyV14) ? TEMPORAL_RELATION_TYPES_V14 : TEMPORAL_RELATION_TYPES;
  const expectedNodeKinds = legacyV02 ? TEMPORAL_NODE_KINDS_V02 : legacyV03 ? TEMPORAL_NODE_KINDS_V03 : legacyV04 ? TEMPORAL_NODE_KINDS_V04 : legacyV05 ? TEMPORAL_NODE_KINDS_V05 : legacyV06 ? TEMPORAL_NODE_KINDS_V06 : legacyV07 ? TEMPORAL_NODE_KINDS_V07 : (legacyV08 || legacyV09 || legacyV10) ? TEMPORAL_NODE_KINDS_V10 : legacyV11 ? TEMPORAL_NODE_KINDS_V11 : (legacyV12 || legacyV13) ? TEMPORAL_NODE_KINDS_V13 : legacyV14 ? TEMPORAL_NODE_KINDS_V14 : TEMPORAL_NODE_KINDS;
  if (canonicalJson(graph.relationTypes) !== canonicalJson([...expectedRelationTypes])
    || canonicalJson(graph.nodeKinds) !== canonicalJson([...expectedNodeKinds])) {
    fail("Temporal graph vocabulary does not match the implemented allowlist.", "TEMPORAL_VOCABULARY_MISMATCH");
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail("Temporal graph nodes and edges are required.", "INVALID_TEMPORAL_PROVENANCE_GRAPH");
  if (canonicalJson(graph.nodes.map((node) => node.nodeId)) !== canonicalJson(graph.nodes.map((node) => node.nodeId).sort())
    || canonicalJson(graph.edges.map((edge) => edge.edgeId)) !== canonicalJson(graph.edges.map((edge) => edge.edgeId).sort())) {
    fail("Temporal graph nodes and edges must use deterministic ordering.", "TEMPORAL_ORDER_MISMATCH");
  }
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!expectedNodeKinds.includes(node.kind) || typeof node.nodeId !== "string") fail("Temporal graph contains an unsupported node.", "UNSUPPORTED_TEMPORAL_NODE");
    if (nodes.has(node.nodeId)) fail(`Duplicate temporal node: ${node.nodeId}`, "DUPLICATE_TEMPORAL_NODE");
    requireMetadata(node, `Node ${node.nodeId}`, { sourceSnapshotRequired: node.kind !== "SourceSnapshot" });
    if (format.dialect === "lode" && node.producer !== format.protocol(PRODUCER)) fail(`Node ${node.nodeId} has a different producer family.`, "INVALID_TEMPORAL_PROVENANCE_GRAPH");
    if (node.kind !== "SourceSnapshot" && node.sourceSnapshotId !== graph.sourceSnapshotId) fail(`Node ${node.nodeId} is scoped to a different SourceSnapshot.`, "TEMPORAL_SCOPE_MISMATCH");
    for (const field of ["parentRevisionIds", "parentSnapshotIds", "fileRevisionIds", "symbolRevisionIds", "testRevisionIds", "productRevisionIds"]) {
      if (node[field] && canonicalJson(node[field]) !== canonicalJson([...new Set(node[field])].sort())) fail(`Node ${node.nodeId} has a non-normalized ${field}.`, "INVALID_TEMPORAL_PARENT_SET");
    }
    if (expectedNodeId(node) !== node.nodeId) fail(`Temporal node identity mismatch: ${node.nodeId}`, "TEMPORAL_NODE_IDENTITY_MISMATCH");
    if ((PRODUCT_DEFINITIONS[node.kind] || Object.keys(PRODUCT_DEFINITIONS).some((kind) => node.kind === `${kind}Revision`))
      && (node.authorityClass !== "canon-projected" || node.origin !== "project-product-canon")) {
      fail(`Product node ${node.nodeId} has invalid projection authority.`, "INVALID_PRODUCT_PROJECTION_AUTHORITY");
    }
    nodes.set(node.nodeId, node);
  }
  if (legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) {
    const lineageState = normalizeLogicalLineageState(graph.logicalLineageState);
    const retired = new Set(lineageState.retiredLogicalEntityIds);
    for (const logicalEntityId of lineageState.discontinuousLogicalEntityIds) {
      if (!retired.has(logicalEntityId) || !CURRENT_LOGICAL_NODE_KINDS.has(nodes.get(logicalEntityId)?.kind)) {
        fail(`Discontinuous lineage is not a retired current logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
      }
    }
    for (const [logicalEntityId, generation] of Object.entries(lineageState.continuityGenerationByLogicalEntityId)) {
      if ((!retired.has(logicalEntityId) && !CURRENT_LOGICAL_NODE_KINDS.has(nodes.get(logicalEntityId)?.kind))
        || !Number.isSafeInteger(generation) || generation < 1) {
        fail(`Continuity generation has no current or retired logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
      }
    }
    for (const logicalEntityId of lineageState.continuityUnknownLogicalEntityIds) {
      if (!CURRENT_LOGICAL_NODE_KINDS.has(nodes.get(logicalEntityId)?.kind) && !retired.has(logicalEntityId)) {
        fail(`Unknown continuity references neither a current nor retired logical entity: ${logicalEntityId}`, "INVALID_LOGICAL_LINEAGE_STATE");
      }
    }
  }
  const sourceSnapshot = nodes.get(graph.sourceSnapshotId);
  if (!sourceSnapshot || sourceSnapshot.kind !== "SourceSnapshot") fail("Current SourceSnapshot node is missing.", "SOURCE_SNAPSHOT_MISSING");
  if (sourceSnapshot.parentSnapshotIds.includes(sourceSnapshot.nodeId)) fail("A SourceSnapshot cannot parent itself.", "TEMPORAL_SOURCE_CYCLE");
  if (sourceSnapshot.projectId !== graph.projectId
    || sourceSnapshot.productModelId !== graph.productModelId
    || ((legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) && sourceSnapshot.productModelSchemaVersion !== graph.productModelSchemaVersion)
    || canonicalJson(sourceSnapshot.parentSnapshotIds) !== canonicalJson(graph.parentSourceSnapshotIds)) {
    fail("SourceSnapshot scope or parents do not match the GraphSnapshot.", "SOURCE_SNAPSHOT_SCOPE_MISMATCH");
  }
  const actualFileRevisionIds = graph.nodes.filter((node) => node.kind === "FileRevision").map((node) => node.nodeId).sort();
  const actualSymbolRevisionIds = graph.nodes.filter((node) => node.kind === "SymbolRevision").map((node) => node.nodeId).sort();
  const actualTestRevisionIds = graph.nodes.filter((node) => node.kind === "TestRevision").map((node) => node.nodeId).sort();
  const productRevisionKinds = Object.keys(PRODUCT_DEFINITIONS).map((kind) => `${kind}Revision`);
  const actualProductRevisionIds = graph.nodes.filter((node) => productRevisionKinds.includes(node.kind)).map((node) => node.nodeId).sort();
  if (canonicalJson(sourceSnapshot.fileRevisionIds) !== canonicalJson(actualFileRevisionIds)
    || canonicalJson(sourceSnapshot.symbolRevisionIds) !== canonicalJson(actualSymbolRevisionIds)
    || canonicalJson(sourceSnapshot.testRevisionIds) !== canonicalJson(actualTestRevisionIds)
    || canonicalJson(sourceSnapshot.productRevisionIds) !== canonicalJson(actualProductRevisionIds)) {
    fail("SourceSnapshot revision sets do not match the projected revisions.", "SOURCE_SNAPSHOT_REVISION_MISMATCH");
  }
  const expectedStateDigest = digest(canonicalJson({
    projectId: graph.projectId,
    fileRevisionIds: actualFileRevisionIds,
    symbolRevisionIds: actualSymbolRevisionIds,
    testRevisionIds: actualTestRevisionIds,
    productRevisionIds: actualProductRevisionIds,
    productModelId: graph.productModelId,
    producerVersion: sourceSnapshot.producerVersion,
  }));
  if (sourceSnapshot.stateDigest !== expectedStateDigest) fail("SourceSnapshot state digest is invalid.", "SOURCE_SNAPSHOT_STATE_MISMATCH");
  const repositories = graph.nodes.filter((node) => node.kind === "Repository");
  if (repositories.length !== 1 || repositories[0].projectId !== graph.projectId) fail("Temporal graph requires exactly one matching Repository.", "TEMPORAL_REPOSITORY_MISMATCH");
  const reconstructedProductDocument = { schemaVersion: (legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? graph.productModelSchemaVersion : 1 };
  for (const [kind, definition] of Object.entries(PRODUCT_DEFINITIONS)) {
    const revisions = graph.nodes.filter((node) => node.kind === `${kind}Revision`);
    const logicals = graph.nodes.filter((node) => node.kind === kind);
    if (revisions.length !== logicals.length) fail(`${kind} logical and Revision counts differ.`, "PRODUCT_REVISION_SET_MISMATCH");
    if (kind !== "Policy" || reconstructedProductDocument.schemaVersion === 2) reconstructedProductDocument[definition.collection] = revisions.map((node) => node.semantic);
  }
  const reconstructedProductModel = normalizeProductModelDocument(reconstructedProductDocument, format);
  if (reconstructedProductModel.productModelId !== graph.productModelId || reconstructedProductModel.productModelHash !== graph.productModelHash) {
    fail("Product model identity does not match product Revision semantics.", "PRODUCT_MODEL_IDENTITY_MISMATCH");
  }
  const actualRevisionParentIds = {};
  for (const node of graph.nodes) {
    if (node.projectId && node.projectId !== graph.projectId) fail(`Node ${node.nodeId} belongs to another project.`, "TEMPORAL_PROJECT_SCOPE_MISMATCH");
    if (!["FileRevision", "SymbolRevision", "TestRevision", ...productRevisionKinds].includes(node.kind)) continue;
    const logical = nodes.get(node.logicalEntityId);
    const expectedLogicalKind = node.kind.replace("Revision", "");
    if (!logical || logical.kind !== expectedLogicalKind) fail(`Revision ${node.nodeId} has no matching logical entity.`, "REVISION_LOGICAL_ENTITY_MISMATCH");
    if (node.parentRevisionIds.length || Object.hasOwn(graph.revisionParentIds, node.logicalEntityId)) {
      actualRevisionParentIds[node.logicalEntityId] = node.parentRevisionIds;
    }
    if (node.kind === "FileRevision" && logical.path !== node.path) fail(`FileRevision ${node.nodeId} path does not match its File.`, "REVISION_LOGICAL_ENTITY_MISMATCH");
    if (node.kind === "SymbolRevision") {
      const qualifiedIdentityMismatch = (legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION)
        && (logical.scopePath !== node.scopePath || logical.qualifiedName !== node.qualifiedName || logical.signature !== node.signature
          || logical.identityAmbiguous !== node.identityAmbiguous || logical.identitySignature !== node.identitySignature
          || logical.identityOccurrence !== node.identityOccurrence || logical.identityBasis !== "qualified-declaration"
          || node.identityBasis !== "qualified-declaration" || !Number.isInteger(node.endLine) || node.endLine < node.line);
      if (logical.fileId !== nodes.get(node.fileRevisionId)?.logicalEntityId || logical.path !== node.path || logical.name !== node.name
        || logical.symbolKind !== node.symbolKind || logical.occurrence !== node.occurrence || qualifiedIdentityMismatch) {
        fail(`SymbolRevision ${node.nodeId} does not match its Symbol.`, "REVISION_LOGICAL_ENTITY_MISMATCH");
      }
    }
    if (node.kind === "TestRevision" && (logical.path !== node.path || logical.fileId !== nodes.get(node.fileRevisionId)?.logicalEntityId)) {
      fail(`TestRevision ${node.nodeId} does not match its Test.`, "REVISION_LOGICAL_ENTITY_MISMATCH");
    }
    if (productRevisionKinds.includes(node.kind) && logical.key !== node.key) {
      fail(`${node.kind} ${node.nodeId} does not match its logical product entity.`, "REVISION_LOGICAL_ENTITY_MISMATCH");
    }
  }
  if (canonicalJson(actualRevisionParentIds) !== canonicalJson(graph.revisionParentIds)) {
    fail("GraphSnapshot revision parent map does not match Revision nodes.", "REVISION_PARENT_MAP_MISMATCH");
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!expectedRelationTypes.includes(edge.type)) fail(`Unsupported temporal relation: ${edge.type}`, "UNSUPPORTED_TEMPORAL_RELATION");
    if (edgeIds.has(edge.edgeId)) fail(`Duplicate temporal edge: ${edge.edgeId} (${edge.type} ${edge.from} -> ${edge.to})`, "DUPLICATE_TEMPORAL_EDGE");
    requireMetadata(edge, `Edge ${edge.edgeId}`);
    if (format.dialect === "lode" && edge.producer !== format.protocol(PRODUCER)) fail(`Edge ${edge.edgeId} has a different producer family.`, "INVALID_TEMPORAL_PROVENANCE_GRAPH");
    if (edge.sourceSnapshotId !== graph.sourceSnapshotId) fail(`Edge ${edge.edgeId} is scoped to a different SourceSnapshot.`, "TEMPORAL_SCOPE_MISMATCH");
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) fail(`Temporal edge ${edge.edgeId} has a dangling endpoint.`, "TEMPORAL_DANGLING_ENDPOINT");
    if (!validEndpointKinds(edge.type, from.kind, to.kind)) fail(`Temporal edge ${edge.edgeId} has invalid endpoint kinds.`, "TEMPORAL_ENDPOINT_KIND_MISMATCH");
    if (edge.type === "AT_REVISION" && from.kind === "ObservationRecord") {
      const payload = from.payload || {};
      if (from.typeKey !== "delivery.state" || payload.revision_binding !== "verified-source-revision"
        || edge.origin !== "verified-delivery-revision-binding" || edge.authorityClass !== "derived"
        || edge.to !== payload.bound_revision_id || to.logicalEntityId !== payload.bound_logical_entity_id
        || to.path !== payload.bound_source_path || to.digest !== payload.revision_digest) {
        fail("Delivery Observation source revision relation is invalid.", "DELIVERY_REVISION_REFERENCE_INVALID");
      }
    }
    const payloadForId = { ...edge };
    delete payloadForId.edgeId;
    if (identity("temporal-edge", payloadForId) !== edge.edgeId) fail(`Temporal edge identity mismatch: ${edge.edgeId}`, "TEMPORAL_EDGE_IDENTITY_MISMATCH");
    edgeIds.add(edge.edgeId);
  }
  const edgeLookup = new Set(graph.edges.map((edge) => canonicalJson([edge.type, edge.from, edge.to])));
  const hasEdge = (type, from, to) => edgeLookup.has(canonicalJson([type, from, to]));
  for (const parentSnapshotId of graph.parentSourceSnapshotIds) {
    if (nodes.get(parentSnapshotId)?.kind !== "SourceSnapshotReference" || !hasEdge("PARENT_OF", parentSnapshotId, graph.sourceSnapshotId)) {
      fail(`SourceSnapshot parent projection is incomplete: ${parentSnapshotId}`, "SOURCE_SNAPSHOT_PARENT_MISSING");
    }
  }
  for (const node of graph.nodes) {
    if (!["FileRevision", "SymbolRevision", "TestRevision", ...productRevisionKinds].includes(node.kind)) continue;
    if (!hasEdge("HAS_REVISION", node.logicalEntityId, node.nodeId) || !hasEdge("CURRENT_REVISION", node.logicalEntityId, node.nodeId)) {
      fail(`Revision projection is missing logical links: ${node.nodeId}`, "REVISION_LINK_MISSING");
    }
    for (const parentRevisionId of node.parentRevisionIds) {
      const reference = nodes.get(parentRevisionId);
      if (!reference || reference.kind !== "RevisionReference" || reference.logicalEntityId !== node.logicalEntityId
        || reference.revisionKind !== node.kind || revisionReferenceKind(parentRevisionId) !== node.kind
        || !hasEdge("PARENT_OF", parentRevisionId, node.nodeId)) {
        fail(`Revision parent projection is incomplete: ${parentRevisionId}`, "REVISION_PARENT_MISSING");
      }
    }
  }
  const onboardingDescriptor = legacyV02 ? onboardingProjectionDescriptor(null) : graph.onboardingProjection;
  if (!onboardingDescriptor || !["not-provided", "projected"].includes(onboardingDescriptor.status)) {
    fail("Temporal graph onboarding projection descriptor is invalid.", "INVALID_ONBOARDING_TEMPORAL_PROJECTION");
  }
  for (const field of ["candidateSetIds", "reviewDecisionIds", "productModelRevisionIds"]) {
    if (!Array.isArray(onboardingDescriptor[field])
      || canonicalJson(onboardingDescriptor[field]) !== canonicalJson([...new Set(onboardingDescriptor[field])].sort())) {
      fail(`Temporal graph onboarding ${field} must be sorted and unique.`, "INVALID_ONBOARDING_TEMPORAL_PROJECTION");
    }
  }
  if (onboardingDescriptor.status === "projected"
    && (!/^onboarding-graph-input-[a-f0-9]{24}$/.test(onboardingDescriptor.projectionInputId || "")
      || !/^[a-f0-9]{64}$/.test(onboardingDescriptor.projectionInputHash || ""))) {
    fail("Temporal graph onboarding projection identity is invalid.", "INVALID_ONBOARDING_TEMPORAL_PROJECTION");
  }
  if (onboardingDescriptor.status === "not-provided"
    && (onboardingDescriptor.projectionInputId != null || onboardingDescriptor.projectionInputHash != null
      || onboardingDescriptor.candidateSetIds.length || onboardingDescriptor.reviewDecisionIds.length
      || onboardingDescriptor.productModelRevisionIds.length)) {
    fail("Temporal graph claims onboarding artifacts without a projection input.", "INVALID_ONBOARDING_TEMPORAL_PROJECTION");
  }
  const onboardingCandidateSets = graph.nodes.filter((node) => node.kind === "OnboardingCandidateSet");
  const onboardingCandidates = graph.nodes.filter((node) => node.kind === "OnboardingProductCandidate");
  const onboardingEvidence = graph.nodes.filter((node) => node.kind === "OnboardingEvidence");
  const onboardingUnknowns = graph.nodes.filter((node) => node.kind === "OnboardingUnknown");
  const onboardingReviews = graph.nodes.filter((node) => node.kind === "OnboardingReviewDecision");
  const onboardingReviewsById = new Map(onboardingReviews.map((review) => [review.nodeId, review]));
  const productModelRevisions = graph.nodes.filter((node) => node.kind === "ProductModelRevision");
  const productConceptReferences = graph.nodes.filter((node) => node.kind === "ProductConceptReference");
  const historicalCandidateReferences = graph.nodes.filter((node) => node.kind === "HistoricalOnboardingCandidateReference");
  const idsOf = (records) => records.map((record) => record.nodeId).sort();
  if (canonicalJson(idsOf(onboardingCandidateSets)) !== canonicalJson(onboardingDescriptor.candidateSetIds)
    || canonicalJson(idsOf(onboardingReviews)) !== canonicalJson(onboardingDescriptor.reviewDecisionIds)
    || canonicalJson(idsOf(productModelRevisions)) !== canonicalJson(onboardingDescriptor.productModelRevisionIds)) {
    fail("Temporal graph onboarding artifact sets do not match the projection descriptor.", "ONBOARDING_TEMPORAL_SET_MISMATCH");
  }
  if (graphVersion === TEMPORAL_PROVENANCE_VERSION) {
    const coverage = onboardingDescriptor.historicalCoverage;
    if (coverage == null) {
      if (historicalCandidateReferences.length || graph.edges.some((edge) => edge.type === "HISTORICALLY_FOLLOWS")) {
        fail("Temporal graph has historical onboarding lineage without coverage.", "INVALID_ONBOARDING_HISTORICAL_COVERAGE");
      }
    } else {
      if (!/^historical-boundary-[a-f0-9]{24}$/.test(coverage.boundaryId || "") || !/^[a-f0-9]{64}$/.test(coverage.boundaryHash || "")) {
        fail("Temporal onboarding historical boundary identity is invalid.", "INVALID_ONBOARDING_HISTORICAL_COVERAGE");
      }
      for (const field of ["opaqueCandidateSetIds", "opaqueReviewDecisionIds", "typedRevisionIds", "opaqueRevisionIds", "legacyWorldEmbeddingReferenceIds", "continuityReceiptIds"]) {
        if (!Array.isArray(coverage[field]) || canonicalJson(coverage[field]) !== canonicalJson([...new Set(coverage[field])].sort())) {
          fail(`Onboarding historical ${field} must be sorted and unique.`, "INVALID_ONBOARDING_HISTORICAL_COVERAGE");
        }
      }
      if (coverage.typedRevisionIds.some((id) => coverage.opaqueRevisionIds.includes(id))
        || coverage.typedRevisionIds.some((id) => !productModelRevisions.some((revision) => revision.nodeId === id))
        || coverage.opaqueRevisionIds.some((id) => productModelRevisions.some((revision) => revision.nodeId === id))) {
        fail("Historical Product revision coverage does not match typed graph membership.", "ONBOARDING_TEMPORAL_SET_MISMATCH");
      }
      if (canonicalJson(idsOf(historicalCandidateReferences)) !== canonicalJson(coverage.opaqueCandidateSetIds)) {
        fail("Historical onboarding reference nodes do not match coverage.", "ONBOARDING_TEMPORAL_SET_MISMATCH");
      }
      const receiptIds = new Set(coverage.continuityReceiptIds);
      for (const reference of historicalCandidateReferences) {
        if (reference.nodeId !== reference.referencedCandidateSetId || reference.boundaryId !== coverage.boundaryId
          || !/^[a-f0-9]{64}$/.test(reference.artifactSha256 || "") || !Array.isArray(reference.continuityReceiptIds)
          || reference.continuityReceiptIds.some((id) => !receiptIds.has(id))) {
          fail("Historical onboarding reference node is invalid.", "INVALID_ONBOARDING_TEMPORAL_NODE");
        }
      }
      const continuityEdges = graph.edges.filter((edge) => edge.type === "HISTORICALLY_FOLLOWS");
      const projectedReceiptIds = continuityEdges.flatMap((edge) => edge.evidenceIds.filter((id) => /^historical-continuity-[a-f0-9]{24}$/.test(id))).sort();
      if (canonicalJson(projectedReceiptIds) !== canonicalJson(coverage.continuityReceiptIds)
        || continuityEdges.some((edge) => !coverage.opaqueCandidateSetIds.includes(edge.from) || !onboardingDescriptor.candidateSetIds.includes(edge.to))) {
        fail("Historical onboarding continuity edges do not match coverage.", "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
      for (const reference of historicalCandidateReferences) {
        const exactReceiptIds = continuityEdges.filter((edge) => edge.from === reference.nodeId)
          .flatMap((edge) => edge.evidenceIds.filter((id) => /^historical-continuity-[a-f0-9]{24}$/.test(id))).sort();
        if (canonicalJson(reference.continuityReceiptIds) !== canonicalJson(exactReceiptIds)) {
          fail("Historical onboarding reference receipt bindings are incomplete.", "ONBOARDING_TEMPORAL_RELATION_MISSING");
        }
      }
    }
  }
  const onboardingCandidateIds = new Set(idsOf(onboardingCandidates));
  const onboardingEvidenceIds = new Set(idsOf(onboardingEvidence));
  const onboardingUnknownIds = new Set(idsOf(onboardingUnknowns));
  const productModelRevisionIds = new Set(idsOf(productModelRevisions));
  const containingSetsByCandidate = new Map();
  for (const candidateSet of onboardingCandidateSets) {
    const producerReviewDecisionId = legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION
      ? candidateSet.producerReviewDecisionId
      : candidateSet.successorReviewDecisionId;
    if (!/^[a-f0-9]{64}$/.test(candidateSet.candidateSetHash || "")
      || (candidateSet.evidenceWorldModelId != null && !/^world-model-[a-f0-9]{24}$/.test(candidateSet.evidenceWorldModelId))
      || !/^source-snapshot-[a-f0-9]{24}$/.test(candidateSet.evidenceSourceSnapshotId || "")
      || !/^product-model-[a-f0-9]{24}$/.test(candidateSet.evidenceProductModelId || "")
      || (producerReviewDecisionId != null && !/^onboarding-review-decision-[a-f0-9]{24}$/.test(producerReviewDecisionId))) {
      fail(`Onboarding candidate-set node is invalid: ${candidateSet.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
    }
    if ((legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) && Object.hasOwn(candidateSet, "successorReviewDecisionId")) {
      fail(`Onboarding candidate-set node uses a legacy producer field: ${candidateSet.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
    }
    for (const [field, known] of [["candidateIds", onboardingCandidateIds], ["onboardingEvidenceIds", onboardingEvidenceIds], ["unknownIds", onboardingUnknownIds]]) {
      if (!Array.isArray(candidateSet[field]) || candidateSet[field].some((id) => !known.has(id))) {
        fail(`Onboarding candidate set has invalid ${field}: ${candidateSet.nodeId}`, "ONBOARDING_TEMPORAL_DANGLING_REFERENCE");
      }
      for (const id of candidateSet[field]) if (!hasEdge("CONTAINS", candidateSet.nodeId, id)) {
        fail(`Onboarding candidate-set containment is missing: ${candidateSet.nodeId} -> ${id}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
    }
    const proposedFrom = graph.edges.filter((edge) => edge.type === "PROPOSES_FROM" && edge.from === candidateSet.nodeId);
    if (proposedFrom.length !== 1 || proposedFrom[0].to !== candidateSet.evidenceSourceSnapshotId) {
      fail(`Onboarding candidate-set source relation is invalid: ${candidateSet.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
    }
    for (const parentId of candidateSet.parentCandidateSetIds || []) if (!hasEdge("PARENT_OF", parentId, candidateSet.nodeId)) {
      fail(`Onboarding candidate-set parent relation is missing: ${candidateSet.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
    }
    if (producerReviewDecisionId) {
      const producerReview = onboardingReviewsById.get(producerReviewDecisionId);
      if (!producerReview || producerReview.disposition !== "revise"
        || !(candidateSet.parentCandidateSetIds || []).includes(producerReview.candidateSetId)
        || ((legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) && !hasEdge("PRODUCES", producerReviewDecisionId, candidateSet.nodeId))) {
        fail(`Onboarding successor producer lineage is invalid: ${candidateSet.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
    }
    for (const candidateId of candidateSet.candidateIds) {
      const memberships = containingSetsByCandidate.get(candidateId) || [];
      memberships.push(candidateSet.nodeId);
      containingSetsByCandidate.set(candidateId, memberships);
    }
  }
  for (const candidate of onboardingCandidates) {
    if (!/^[a-f0-9]{64}$/.test(candidate.candidateHash || "") || !Object.keys(PRODUCT_DEFINITIONS).includes(candidate.productKind)
      || !/^source-snapshot-[a-f0-9]{24}$/.test(candidate.evidenceSourceSnapshotId || "")) {
      fail(`Onboarding candidate node is invalid: ${candidate.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
    }
    if (!(containingSetsByCandidate.get(candidate.nodeId) || []).length) {
      fail(`Onboarding candidate must belong to at least one candidate set: ${candidate.nodeId}`, "ONBOARDING_TEMPORAL_SET_MISMATCH");
    }
    const targetEdges = graph.edges.filter((edge) => edge.type === "PROPOSES_TO" && edge.from === candidate.nodeId);
    if (targetEdges.length !== 1 || nodes.get(targetEdges[0].to)?.kind !== "ProductConceptReference") {
      fail(`Onboarding candidate target relation is invalid: ${candidate.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
    }
    const supportedIds = graph.edges.filter((edge) => edge.type === "SUPPORTED_BY" && edge.from === candidate.nodeId).map((edge) => edge.to).sort();
    if (canonicalJson(supportedIds) !== canonicalJson(candidate.evidenceIds)) {
      fail(`Onboarding candidate Evidence relations are incomplete: ${candidate.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const evidence of onboardingEvidence) {
    if (!/^[a-f0-9]{64}$/.test(evidence.onboardingEvidenceHash || "") || typeof evidence.statement !== "string" || !evidence.statement) {
      fail(`Onboarding Evidence node is invalid: ${evidence.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
    }
  }
  for (const unknown of onboardingUnknowns) if (!/^onboarding-unknown-[a-f0-9]{24}$/.test(unknown.nodeId) || unknown.unknownStatus !== "open") {
    fail(`Onboarding Unknown node is invalid: ${unknown.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
  }
  for (const reference of productConceptReferences) if (!Object.keys(PRODUCT_DEFINITIONS).includes(reference.productKind) || typeof reference.key !== "string" || !reference.key) {
    fail(`Product concept reference is invalid: ${reference.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
  }
  for (const revision of productModelRevisions) if (!/^[a-f0-9]{64}$/.test(revision.productModelHash || "")
    || !revision.entityCounts || Object.values(revision.entityCounts).some((count) => !Number.isInteger(count) || count < 0)) {
    fail(`Product Model revision node is invalid: ${revision.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
  }
  let acceptedCandidateCount = 0;
  let rejectedCandidateCount = 0;
  for (const review of onboardingReviews) {
    if (!/^[a-f0-9]{64}$/.test(review.reviewDecisionHash || "")
      || !["accept-all", "accept-selection", "revise", "reject"].includes(review.disposition)
      || !onboardingDescriptor.candidateSetIds.includes(review.candidateSetId)
      || review.sourceAuthority !== "explicit-user-onboarding-review" || typeof review.sourcePromotionAuthority !== "boolean") {
      fail(`Onboarding ReviewDecision node is invalid: ${review.nodeId}`, "INVALID_ONBOARDING_TEMPORAL_NODE");
    }
    if (!hasEdge("REVIEWED_BY", review.candidateSetId, review.nodeId)) {
      fail(`Onboarding review relation is missing: ${review.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
    }
    for (const candidateId of review.acceptedCandidateIds) {
      if (!onboardingCandidateIds.has(candidateId) || !hasEdge("ACCEPTED_BY", candidateId, review.nodeId)) {
        fail(`Onboarding acceptance relation is missing: ${candidateId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
      acceptedCandidateCount += 1;
    }
    for (const candidateId of review.rejectedCandidateIds) {
      if (!onboardingCandidateIds.has(candidateId) || !hasEdge("REJECTED_BY", candidateId, review.nodeId)) {
        fail(`Onboarding rejection relation is missing: ${candidateId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
      rejectedCandidateCount += 1;
    }
    if (review.sourcePromotionAuthority) {
      if (!productModelRevisionIds.has(review.previousProductModelId) || !productModelRevisionIds.has(review.resultingProductModelId)
        || !hasEdge("PRODUCES", review.nodeId, review.resultingProductModelId)) {
        fail(`Onboarding promotion receipt is incomplete: ${review.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
      if (review.previousProductModelId !== review.resultingProductModelId
        && !hasEdge("PARENT_OF", review.previousProductModelId, review.resultingProductModelId)) {
        fail(`Product Model revision ancestry is missing: ${review.nodeId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
      for (const candidateId of review.acceptedCandidateIds) if (!hasEdge("PROMOTED_FROM", review.resultingProductModelId, candidateId)) {
        fail(`Product Model promotion provenance is missing: ${candidateId}`, "ONBOARDING_TEMPORAL_RELATION_MISSING");
      }
    }
  }
  const policyDescriptor = (legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? graph.productPolicyProjection : productPolicyProjectionDescriptor(null);
  if (!policyDescriptor || !["not-provided", "projected"].includes(policyDescriptor.status)) fail("Temporal graph Product Policy projection descriptor is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  for (const field of ["candidateIds", "reviewDecisionIds"]) {
    if (!Array.isArray(policyDescriptor[field]) || canonicalJson(policyDescriptor[field]) !== canonicalJson([...new Set(policyDescriptor[field])].sort())) fail(`Temporal graph Product Policy ${field} must be sorted and unique.`, "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  }
  if (policyDescriptor.status === "projected" && (!/^product-policy-projection-[a-f0-9]{24}$/.test(policyDescriptor.projectionInputId || "") || !/^[a-f0-9]{64}$/.test(policyDescriptor.projectionInputHash || ""))) fail("Temporal graph Product Policy projection identity is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_PROJECTION");
  const policyCandidates = graph.nodes.filter((node) => node.kind === "ProductPolicyCandidate");
  const policyEvidence = graph.nodes.filter((node) => node.kind === "ProductPolicyEvidence");
  const policyReviews = graph.nodes.filter((node) => node.kind === "ProductPolicyReviewDecision");
  const productModelReferences = graph.nodes.filter((node) => node.kind === "ProductModelRevisionReference");
  if (canonicalJson(idsOf(policyCandidates)) !== canonicalJson(policyDescriptor.candidateIds)
    || canonicalJson(idsOf(policyReviews)) !== canonicalJson(policyDescriptor.reviewDecisionIds)) fail("Product Policy projected artifact sets do not match the descriptor.", "PRODUCT_POLICY_TEMPORAL_SET_MISMATCH");
  for (const reference of productModelReferences) if (!/^product-model-[a-f0-9]{24}$/.test(reference.referencedProductModelId || "") || !/^[a-f0-9]{64}$/.test(reference.referencedProductModelHash || "")) fail("Product Model revision reference is invalid.", "INVALID_PRODUCT_POLICY_TEMPORAL_NODE");
  const policyReviewById = new Map(policyReviews.map((review) => [review.nodeId, review]));
  const policyRevisionByKeyAndSemanticHash = new Map(graph.nodes.filter((node) => node.kind === "PolicyRevision")
    .map((node) => [`${node.key}:${digest(canonicalJson(node.semantic))}`, node]));
  for (const candidate of policyCandidates) {
    if (!/^[a-f0-9]{64}$/.test(candidate.candidateHash || "") || !/^[a-f0-9]{64}$/.test(candidate.proposedPolicyHash || "") || !["create", "revise", "retire"].includes(candidate.operation)
      || !["awaiting-review", "rejected", "applied-current", "applied-historical", "application-pending-or-diverged"].includes(candidate.applicationStatus)
      || !graph.edges.some((edge) => edge.type === "PROPOSES_FROM" && edge.from === candidate.nodeId && nodes.get(edge.to)?.kind === "ProductModelRevisionReference" && nodes.get(edge.to).referencedProductModelId === candidate.baseProductModelId)
      || !graph.edges.some((edge) => edge.type === "PROPOSES_TO" && edge.from === candidate.nodeId && nodes.get(edge.to)?.kind === "ProductModelRevisionReference" && nodes.get(edge.to).referencedProductModelId === candidate.resultingProductModelId)) fail(`Product Policy candidate lineage is incomplete: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_RELATION_MISSING");
    const supported = graph.edges.filter((edge) => edge.type === "SUPPORTED_BY" && edge.from === candidate.nodeId).map((edge) => edge.to).sort();
    const declaredEvidenceNodeIds = [...candidate.evidenceNodeIds].sort();
    if (canonicalJson(supported) !== canonicalJson(declaredEvidenceNodeIds) || supported.some((id) => nodes.get(id)?.kind !== "ProductPolicyEvidence")) fail(`Product Policy evidence lineage is incomplete: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_RELATION_MISSING");
    if (!candidate.reviewDecisionId) continue;
    const review = policyReviewById.get(candidate.reviewDecisionId);
    if (!review || review.candidateId !== candidate.nodeId || !hasEdge("REVIEWED_BY", candidate.nodeId, review.nodeId)
      || !hasEdge(review.disposition === "accept" ? "ACCEPTED_BY" : "REJECTED_BY", candidate.nodeId, review.nodeId)) fail(`Product Policy review lineage is incomplete: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_RELATION_MISSING");
    const applied = candidate.applicationStatus.startsWith("applied-");
    const producesModel = graph.edges.some((edge) => edge.type === "PRODUCES" && edge.from === review.nodeId && nodes.get(edge.to)?.kind === "ProductModelRevisionReference" && nodes.get(edge.to).referencedProductModelId === candidate.resultingProductModelId);
    if (applied !== producesModel) fail(`Product Policy application lineage is inaccurate: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_RELATION_MISSING");
    const matchingPolicyRevision = policyRevisionByKeyAndSemanticHash.get(`${candidate.policyKey}:${candidate.proposedPolicyHash}`) || null;
    const producedPolicyRevisionIds = graph.edges.filter((edge) => edge.type === "PRODUCES" && edge.from === review.nodeId && nodes.get(edge.to)?.kind === "PolicyRevision").map((edge) => edge.to).sort();
    const expectedPolicyRevisionIds = applied && matchingPolicyRevision ? [matchingPolicyRevision.nodeId] : [];
    if (canonicalJson(producedPolicyRevisionIds) !== canonicalJson(expectedPolicyRevisionIds)) fail(`Product Policy entity-level approval lineage is inaccurate: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_REVISION_MISSING");
    if (applied && matchingPolicyRevision) {
      const resultReference = graph.nodes.find((node) => node.kind === "ProductModelRevisionReference" && node.referencedProductModelId === candidate.resultingProductModelId);
      if (!resultReference || !hasEdge("REFERENCES", resultReference.nodeId, matchingPolicyRevision.nodeId)) fail(`Product Policy entity-level revision reference is missing: ${candidate.nodeId}`, "PRODUCT_POLICY_TEMPORAL_REVISION_MISSING");
    }
  }
  for (const evidence of policyEvidence) if (!policyCandidates.some((candidate) => candidate.nodeId === evidence.candidateId) || !hasEdge("SUPPORTED_BY", evidence.candidateId, evidence.nodeId)) fail(`Product Policy evidence is dangling: ${evidence.nodeId}`, "PRODUCT_POLICY_TEMPORAL_RELATION_MISSING");
  const mappingDescriptor = (legacyV02 || legacyV03) ? featureMappingProjectionDescriptor(null) : graph.featureMappingProjection;
  if (!mappingDescriptor || !["not-provided", "projected"].includes(mappingDescriptor.status)) {
    fail("Temporal graph Feature mapping projection descriptor is invalid.", "INVALID_FEATURE_MAPPING_TEMPORAL_PROJECTION");
  }
  for (const field of ["candidateSetIds", "reviewDecisionIds"]) {
    if (!Array.isArray(mappingDescriptor[field])
      || canonicalJson(mappingDescriptor[field]) !== canonicalJson([...new Set(mappingDescriptor[field])].sort())) {
      fail(`Temporal graph Feature mapping ${field} must be sorted and unique.`, "INVALID_FEATURE_MAPPING_TEMPORAL_PROJECTION");
    }
  }
  if (mappingDescriptor.status === "projected"
    && (!/^feature-mapping-projection-[a-f0-9]{24}$/.test(mappingDescriptor.projectionInputId || "")
      || !/^[a-f0-9]{64}$/.test(mappingDescriptor.projectionInputHash || ""))) {
    fail("Temporal graph Feature mapping projection identity is invalid.", "INVALID_FEATURE_MAPPING_TEMPORAL_PROJECTION");
  }
  if (mappingDescriptor.status === "not-provided"
    && (mappingDescriptor.projectionInputId != null || mappingDescriptor.projectionInputHash != null
      || mappingDescriptor.candidateSetIds.length || mappingDescriptor.reviewDecisionIds.length)) {
    fail("Temporal graph claims Feature mapping artifacts without a projection input.", "INVALID_FEATURE_MAPPING_TEMPORAL_PROJECTION");
  }
  const mappingCandidateSets = graph.nodes.filter((node) => node.kind === "FeatureMappingCandidateSet");
  const mappingCandidates = graph.nodes.filter((node) => node.kind === "FeatureMappingCandidate");
  const mappingEvidence = graph.nodes.filter((node) => node.kind === "FeatureMappingEvidence");
  const mappingUnknowns = graph.nodes.filter((node) => node.kind === "FeatureMappingUnknown");
  const mappingReviews = graph.nodes.filter((node) => node.kind === "FeatureMappingReviewDecision");
  const reviewedRelationships = graph.nodes.filter((node) => node.kind === "ReviewedRelationship");
  if (canonicalJson(idsOf(mappingCandidateSets)) !== canonicalJson(mappingDescriptor.candidateSetIds)
    || canonicalJson(idsOf(mappingReviews)) !== canonicalJson(mappingDescriptor.reviewDecisionIds)) {
    fail("Temporal graph Feature mapping artifact sets do not match the projection descriptor.", "FEATURE_MAPPING_TEMPORAL_SET_MISMATCH");
  }
  const mappingCandidateIds = new Set(idsOf(mappingCandidates));
  const mappingEvidenceIds = new Set(idsOf(mappingEvidence));
  const mappingUnknownIds = new Set(idsOf(mappingUnknowns));
  for (const candidateSet of mappingCandidateSets) {
    if (!/^[a-f0-9]{64}$/.test(candidateSet.candidateSetHash || "")
      || !/^world-model-[a-f0-9]{24}$/.test(candidateSet.evidenceWorldModelId || "")
      || !/^graph-snapshot-[a-f0-9]{24}$/.test(candidateSet.evidenceGraphSnapshotId || "")
      || !/^source-snapshot-[a-f0-9]{24}$/.test(candidateSet.evidenceSourceSnapshotId || "")
      || !/^product-model-[a-f0-9]{24}$/.test(candidateSet.evidenceProductModelId || "")
      || !/^[a-f0-9]{64}$/.test(candidateSet.evidenceProductModelHash || "")) {
      fail(`Feature mapping candidate-set node is invalid: ${candidateSet.nodeId}`, "INVALID_FEATURE_MAPPING_TEMPORAL_NODE");
    }
    for (const [field, known] of [["candidateIds", mappingCandidateIds], ["featureMappingEvidenceIds", mappingEvidenceIds], ["unknownIds", mappingUnknownIds]]) {
      if (!Array.isArray(candidateSet[field]) || candidateSet[field].some((id) => !known.has(id))) {
        fail(`Feature mapping candidate set has invalid ${field}: ${candidateSet.nodeId}`, "FEATURE_MAPPING_TEMPORAL_DANGLING_REFERENCE");
      }
      for (const id of candidateSet[field]) if (!hasEdge("CONTAINS", candidateSet.nodeId, id)) {
        fail(`Feature mapping candidate-set containment is missing: ${candidateSet.nodeId} -> ${id}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
      }
    }
  }
  for (const candidate of mappingCandidates) {
    if (!/^[a-f0-9]{64}$/.test(candidate.candidateHash || "")
      || !["IMPLEMENTS", "VERIFIED_BY"].includes(candidate.relationshipType)
      || !/^source-snapshot-[a-f0-9]{24}$/.test(candidate.evidenceSourceSnapshotId || "")) {
      fail(`Feature mapping candidate node is invalid: ${candidate.nodeId}`, "INVALID_FEATURE_MAPPING_TEMPORAL_NODE");
    }
    const canonicalDirection = candidate.relationshipType === "IMPLEMENTS"
      ? ["File", "Symbol"].includes(candidate.proposedFromKind) && ["Feature", "Capability"].includes(candidate.proposedToKind)
      : ["Feature", "Capability"].includes(candidate.proposedFromKind) && candidate.proposedToKind === "Test";
    const endpointKind = (nodeId) => {
      const endpoint = nodes.get(nodeId);
      return endpoint?.kind === "MappingEndpointReference" ? endpoint.referencedKind : endpoint?.kind;
    };
    if (!canonicalDirection || endpointKind(candidate.proposedFromNodeId) !== candidate.proposedFromKind
      || endpointKind(candidate.proposedToNodeId) !== candidate.proposedToKind) {
      fail(`Feature mapping candidate direction is invalid: ${candidate.nodeId}`, "INVALID_FEATURE_MAPPING_DIRECTION");
    }
    const containing = graph.edges.filter((edge) => edge.type === "CONTAINS" && edge.to === candidate.nodeId && nodes.get(edge.from)?.kind === "FeatureMappingCandidateSet");
    const proposedFrom = graph.edges.filter((edge) => edge.type === "PROPOSES_FROM" && edge.from === candidate.nodeId);
    const proposedTo = graph.edges.filter((edge) => edge.type === "PROPOSES_TO" && edge.from === candidate.nodeId);
    const supportedIds = graph.edges.filter((edge) => edge.type === "SUPPORTED_BY" && edge.from === candidate.nodeId).map((edge) => edge.to).sort();
    if (containing.length < 1 || proposedFrom.length !== 1 || proposedFrom[0].to !== candidate.proposedFromNodeId
      || proposedTo.length !== 1 || proposedTo[0].to !== candidate.proposedToNodeId
      || canonicalJson(supportedIds) !== canonicalJson(candidate.evidenceIds)) {
      fail(`Feature mapping candidate relations are incomplete: ${candidate.nodeId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const evidence of mappingEvidence) if (!/^[a-f0-9]{64}$/.test(evidence.featureMappingEvidenceHash || "")
    || typeof evidence.statement !== "string" || !evidence.statement) {
    fail(`Feature mapping Evidence node is invalid: ${evidence.nodeId}`, "INVALID_FEATURE_MAPPING_TEMPORAL_NODE");
  }
  for (const unknown of mappingUnknowns) if (!/^feature-mapping-unknown-[a-f0-9]{24}$/.test(unknown.nodeId) || unknown.unknownStatus !== "open") {
    fail(`Feature mapping Unknown node is invalid: ${unknown.nodeId}`, "INVALID_FEATURE_MAPPING_TEMPORAL_NODE");
  }
  let mappingAcceptedCandidateCount = 0;
  let mappingRejectedCandidateCount = 0;
  for (const review of mappingReviews) {
    if (!/^[a-f0-9]{64}$/.test(review.reviewDecisionHash || "")
      || !["accept-all", "accept-selection", "reject"].includes(review.disposition)
      || !mappingDescriptor.candidateSetIds.includes(review.candidateSetId)
      || review.sourceAuthority !== "explicit-user-feature-mapping-review"
      || review.sourcePromotionAuthority !== review.disposition.startsWith("accept")
      || !hasEdge("REVIEWED_BY", review.candidateSetId, review.nodeId)) {
      fail(`Feature mapping ReviewDecision node is invalid: ${review.nodeId}`, "INVALID_FEATURE_MAPPING_TEMPORAL_NODE");
    }
    for (const candidateId of review.acceptedCandidateIds) {
      if (!mappingCandidateIds.has(candidateId) || !hasEdge("ACCEPTED_BY", candidateId, review.nodeId)) {
        fail(`Feature mapping acceptance relation is missing: ${candidateId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
      }
      mappingAcceptedCandidateCount += 1;
    }
    for (const candidateId of review.rejectedCandidateIds) {
      if (!mappingCandidateIds.has(candidateId) || !hasEdge("REJECTED_BY", candidateId, review.nodeId)) {
        fail(`Feature mapping rejection relation is missing: ${candidateId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
      }
      mappingRejectedCandidateCount += 1;
    }
  }
  for (const relationship of reviewedRelationships) {
    const currentMappingStatusInvalid = (legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION)
      && (relationship.approvalStatus !== "approved"
        || !["present", "missing", "reintroduced"].includes(relationship.endpointStatus)
        || !["unchanged", "changed", "reintroduced", "unavailable"].includes(relationship.evidenceStatus)
        || !["assessed", "needs-recheck", "not-assessed"].includes(relationship.semanticAssessmentStatus)
        || !["current", "stale-endpoint", "reintroduced-endpoint", "stale-evidence"].includes(relationship.projectionStatus)
        || relationship.projectionCurrent !== (relationship.projectionStatus === "current")
        || relationship.userActionRequired !== false
        || (relationship.currentFromRevisionId !== null && typeof relationship.currentFromRevisionId !== "string")
        || (relationship.currentToRevisionId !== null && typeof relationship.currentToRevisionId !== "string")
        || !Number.isSafeInteger(relationship.approvedFromContinuityGeneration) || relationship.approvedFromContinuityGeneration < 0
        || !Number.isSafeInteger(relationship.approvedToContinuityGeneration) || relationship.approvedToContinuityGeneration < 0
        || (relationship.currentFromContinuityGeneration !== null
          && (!Number.isSafeInteger(relationship.currentFromContinuityGeneration) || relationship.currentFromContinuityGeneration < 0))
        || (relationship.currentToContinuityGeneration !== null
          && (!Number.isSafeInteger(relationship.currentToContinuityGeneration) || relationship.currentToContinuityGeneration < 0)));
    if (!mappingCandidateIds.has(relationship.candidateId)
      || !mappingDescriptor.reviewDecisionIds.includes(relationship.reviewDecisionId)
      || !["IMPLEMENTS", "VERIFIED_BY"].includes(relationship.relationshipType)
      || (graphVersion !== TEMPORAL_PROVENANCE_VERSION && !["current", "stale-endpoint"].includes(relationship.projectionStatus))
      || currentMappingStatusInvalid
      || !hasEdge("PROMOTED_FROM", relationship.nodeId, relationship.candidateId)
      || !hasEdge("PRODUCES", relationship.reviewDecisionId, relationship.nodeId)) {
      fail(`Reviewed relationship receipt is incomplete: ${relationship.nodeId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
    }
    const canonicalDirection = relationship.relationshipType === "IMPLEMENTS"
      ? ["File", "Symbol"].includes(relationship.fromKind) && ["Feature", "Capability"].includes(relationship.toKind)
      : ["Feature", "Capability"].includes(relationship.fromKind) && relationship.toKind === "Test";
    if (!canonicalDirection) fail(`Reviewed relationship direction is invalid: ${relationship.nodeId}`, "INVALID_FEATURE_MAPPING_DIRECTION");
    const hasCanonicalRelationship = hasEdge(relationship.relationshipType, relationship.fromNodeId, relationship.toNodeId);
    if (relationship.projectionStatus === "current" && !hasCanonicalRelationship) {
      fail(`Reviewed relationship projection status is inconsistent: ${relationship.nodeId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const relationshipEdge of graph.edges.filter((edge) => ["IMPLEMENTS", "VERIFIED_BY"].includes(edge.type))) {
    const backedByCurrentReceipt = reviewedRelationships.some((relationship) => relationship.projectionStatus === "current"
      && relationship.relationshipType === relationshipEdge.type
      && relationship.fromNodeId === relationshipEdge.from
      && relationship.toNodeId === relationshipEdge.to);
    if (!backedByCurrentReceipt) {
      fail(`Canonical relationship has no current reviewed receipt: ${relationshipEdge.edgeId}`, "FEATURE_MAPPING_TEMPORAL_RELATION_MISSING");
    }
  }
  const changeDescriptor = (legacyV02 || legacyV03 || legacyV04) ? changeSetProjectionDescriptor(null) : graph.changeSetProjection;
  if (!changeDescriptor || !["not-provided", "projected"].includes(changeDescriptor.status)) {
    fail("Temporal graph ChangeSet projection descriptor is invalid.", "INVALID_CHANGE_SET_TEMPORAL_PROJECTION");
  }
  const changeDescriptorFields = ["changeSetIds", "candidateSetIds", "reviewDecisionIds", ...(!legacyV05 ? ["vcsEvidenceIds"] : [])];
  for (const field of changeDescriptorFields) {
    if (!Array.isArray(changeDescriptor[field])
      || canonicalJson(changeDescriptor[field]) !== canonicalJson([...new Set(changeDescriptor[field])].sort())) {
      fail(`Temporal graph ChangeSet ${field} must be sorted and unique.`, "INVALID_CHANGE_SET_TEMPORAL_PROJECTION");
    }
  }
  if (changeDescriptor.status === "projected"
    && (!/^change-set-projection-[a-f0-9]{24}$/.test(changeDescriptor.projectionInputId || "")
      || !/^[a-f0-9]{64}$/.test(changeDescriptor.projectionInputHash || ""))) {
    fail("Temporal graph ChangeSet projection identity is invalid.", "INVALID_CHANGE_SET_TEMPORAL_PROJECTION");
  }
  if (changeDescriptor.status === "not-provided"
    && (changeDescriptor.projectionInputId != null || changeDescriptor.projectionInputHash != null
      || changeDescriptor.changeSetIds.length || changeDescriptor.candidateSetIds.length || changeDescriptor.reviewDecisionIds.length
      || (!legacyV05 && changeDescriptor.vcsEvidenceIds.length))) {
    fail("Temporal graph claims ChangeSet artifacts without a projection input.", "INVALID_CHANGE_SET_TEMPORAL_PROJECTION");
  }
  const changeSets = graph.nodes.filter((node) => node.kind === "ChangeSet");
  const changeRevisionReferences = graph.nodes.filter((node) => node.kind === "ChangeRevisionReference");
  const changeCandidateSets = graph.nodes.filter((node) => node.kind === "ChangeImpactCandidateSet");
  const changeCandidates = graph.nodes.filter((node) => node.kind === "ChangeImpactCandidate");
  const changeUnknowns = graph.nodes.filter((node) => node.kind === "ChangeImpactUnknown");
  const changeReviews = graph.nodes.filter((node) => node.kind === "ChangeImpactReviewDecision");
  const reviewedImpacts = graph.nodes.filter((node) => node.kind === "ReviewedImpact");
  const vcsEvidenceNodes = graph.nodes.filter((node) => node.kind === "VcsEvidence");
  const gitCommitNodes = graph.nodes.filter((node) => node.kind === "GitCommit");
  if (canonicalJson(idsOf(changeSets)) !== canonicalJson(changeDescriptor.changeSetIds)
    || canonicalJson(idsOf(changeCandidateSets)) !== canonicalJson(changeDescriptor.candidateSetIds)
    || canonicalJson(idsOf(changeReviews)) !== canonicalJson(changeDescriptor.reviewDecisionIds)
    || (!legacyV05 && canonicalJson(idsOf(vcsEvidenceNodes)) !== canonicalJson(changeDescriptor.vcsEvidenceIds))) {
    fail("Temporal graph ChangeSet artifact sets do not match the projection descriptor.", "CHANGE_SET_TEMPORAL_SET_MISMATCH");
  }
  const changeSetIds = new Set(idsOf(changeSets));
  const changeCandidateIds = new Set(idsOf(changeCandidates));
  for (const changeSet of changeSets) {
    if (!/^[a-f0-9]{64}$/.test(changeSet.changeSetHash || "") || changeSet.reviewDisposition !== "accept"
      || changeSet.sourceAuthority !== "reviewed-execution-change-lineage"
      || !hasEdge("SUPPORTED_BY", changeSet.nodeId, changeSet.resultPacketId)
      || !hasEdge("REVIEWED_BY", changeSet.nodeId, changeSet.executionReviewDecisionId)) {
      fail(`ChangeSet node is invalid: ${changeSet.nodeId}`, "INVALID_CHANGE_SET_TEMPORAL_NODE");
    }
    for (const parentId of changeSet.parentChangeSetIds) if (!changeSetIds.has(parentId) || !hasEdge("SUPERSEDES", changeSet.nodeId, parentId)) {
      fail(`ChangeSet parent relation is missing: ${parentId}`, "CHANGE_SET_TEMPORAL_RELATION_MISSING");
    }
    for (const changeId of changeSet.changeIds) if (!changeRevisionReferences.some((reference) => reference.changeSetId === changeSet.nodeId && reference.changeId === changeId)
      || !graph.edges.some((edge) => edge.type === "CHANGES" && edge.from === changeSet.nodeId && nodes.get(edge.to)?.changeId === changeId)) {
      fail(`ChangeSet revision relation is missing: ${changeId}`, "CHANGE_SET_TEMPORAL_RELATION_MISSING");
    }
  }
  if (legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) for (const reference of changeRevisionReferences) {
    if (nodes.has(reference.referencedRevisionId) && !hasEdge("REFERENCES", reference.nodeId, reference.referencedRevisionId)) {
      fail(`Change revision reference is not linked to its exact retained Revision: ${reference.nodeId}`, "CHANGE_SET_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const candidateSet of changeCandidateSets) {
    const coverage = candidateSet.coverage;
    const invalidCoverage = (legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION)
      && (!coverage || coverage.unit !== "repository-path" || !Array.isArray(coverage.units)
        || coverage.totalChangedUnits !== coverage.units.length);
    if (!changeSetIds.has(candidateSet.changeSetId)
      || canonicalJson(candidateSet.candidateIds) !== canonicalJson(candidateSet.candidateIds.slice().sort())
      || canonicalJson(candidateSet.unknownIds) !== canonicalJson(candidateSet.unknownIds.slice().sort()) || invalidCoverage) {
      fail(`Change impact candidate set is invalid: ${candidateSet.nodeId}`, "INVALID_CHANGE_IMPACT_TEMPORAL_NODE");
    }
    for (const candidateId of candidateSet.candidateIds) if (!changeCandidateIds.has(candidateId) || !hasEdge("CONTAINS", candidateSet.nodeId, candidateId)) {
      fail(`Change impact candidate containment is missing: ${candidateId}`, "CHANGE_IMPACT_TEMPORAL_RELATION_MISSING");
    }
    for (const unknownId of candidateSet.unknownIds) if (!changeUnknowns.some((unknown) => unknown.nodeId === unknownId)
      || !hasEdge("CONTAINS", candidateSet.nodeId, unknownId)) {
      fail(`Change impact Unknown containment is missing: ${unknownId}`, "CHANGE_IMPACT_TEMPORAL_RELATION_MISSING");
    }
  }
  if (legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) for (const unknown of changeUnknowns) {
    if (typeof unknown.unknownKind !== "string" || !unknown.unknownKind || !Array.isArray(unknown.changeIds)
      || unknown.unknownStatus !== "open") fail(`Change impact Unknown is invalid: ${unknown.nodeId}`, "INVALID_CHANGE_IMPACT_TEMPORAL_NODE");
  }
  for (const candidate of changeCandidates) {
    if (!changeSetIds.has(candidate.changeSetId) || candidate.relationshipType !== "IMPACTS"
      || !["Feature", "Capability"].includes(candidate.targetKind)
      || !hasEdge("SUPPORTED_BY", candidate.nodeId, candidate.changeSetId)
      || !hasEdge("PROPOSES_TO", candidate.nodeId, candidate.targetNodeId)) {
      fail(`Change impact candidate is invalid: ${candidate.nodeId}`, "INVALID_CHANGE_IMPACT_TEMPORAL_NODE");
    }
  }
  let changeAcceptedCandidateCount = 0;
  let changeRejectedCandidateCount = 0;
  for (const review of changeReviews) {
    if (!changeDescriptor.candidateSetIds.includes(review.candidateSetId)
      || review.sourceAuthority !== "explicit-user-change-impact-review"
      || review.sourcePromotionAuthority !== review.disposition.startsWith("accept")
      || !hasEdge("REVIEWED_BY", review.candidateSetId, review.nodeId)) {
      fail(`Change impact ReviewDecision node is invalid: ${review.nodeId}`, "INVALID_CHANGE_IMPACT_TEMPORAL_NODE");
    }
    for (const candidateId of review.acceptedCandidateIds) {
      if (!changeCandidateIds.has(candidateId) || !hasEdge("ACCEPTED_BY", candidateId, review.nodeId)) fail(`Change impact acceptance relation is missing: ${candidateId}`, "CHANGE_IMPACT_TEMPORAL_RELATION_MISSING");
      changeAcceptedCandidateCount += 1;
    }
    for (const candidateId of review.rejectedCandidateIds) {
      if (!changeCandidateIds.has(candidateId) || !hasEdge("REJECTED_BY", candidateId, review.nodeId)) fail(`Change impact rejection relation is missing: ${candidateId}`, "CHANGE_IMPACT_TEMPORAL_RELATION_MISSING");
      changeRejectedCandidateCount += 1;
    }
  }
  for (const impact of reviewedImpacts) {
    if (!changeCandidateIds.has(impact.candidateId) || !changeDescriptor.reviewDecisionIds.includes(impact.reviewDecisionId)
      || !["current", "historical-source", "stale-endpoint"].includes(impact.projectionStatus)
      || !hasEdge("PROMOTED_FROM", impact.nodeId, impact.candidateId)
      || !hasEdge("PRODUCES", impact.reviewDecisionId, impact.nodeId)
      || ((impact.projectionStatus === "current") !== hasEdge("IMPACTS", impact.changeSetId, impact.targetNodeId))
      || ((legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) && (impact.projectionStatus === "current") !== hasEdge("AT_REVISION", impact.nodeId, impact.targetRevisionId))) {
      fail(`Reviewed impact receipt is incomplete: ${impact.nodeId}`, "CHANGE_IMPACT_TEMPORAL_RELATION_MISSING");
    }
  }
  const gitCommitIds = new Set(idsOf(gitCommitNodes));
  for (const evidence of vcsEvidenceNodes) {
    if (!changeSetIds.has(evidence.changeSetId) || !/^[a-f0-9]{64}$/.test(evidence.vcsEvidenceHash || "")
      || evidence.vcsKind !== "git" || evidence.attachmentMethod !== "explicit-commit-selection"
      || evidence.sourceAuthority !== "optional-derived-vcs-evidence" || evidence.trustBoundary !== "evidence-not-instruction"
      || !Array.isArray(evidence.gitCommitObservationIds)
      || canonicalJson(evidence.gitCommitObservationIds) !== canonicalJson([...new Set(evidence.gitCommitObservationIds)].sort())
      || !hasEdge("MATERIALIZED_AS", evidence.changeSetId, evidence.nodeId)) {
      fail(`VCS evidence node is invalid: ${evidence.nodeId}`, "INVALID_VCS_EVIDENCE_TEMPORAL_NODE");
    }
    for (const observationId of evidence.gitCommitObservationIds) if (!gitCommitIds.has(observationId) || !hasEdge("REFERENCES", evidence.nodeId, observationId)) {
      fail(`VCS evidence commit relation is missing: ${evidence.nodeId} -> ${observationId}`, "VCS_EVIDENCE_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const commit of gitCommitNodes) {
    if (commit.vcsKind !== "git" || !/^[a-f0-9]{64}$/.test(commit.gitCommitObservationHash || "")
      || !/^[a-f0-9]{40,64}$/.test(commit.objectId || "") || commit.sourceAuthority !== "derived-vcs-observation"
      || commit.trustBoundary !== "evidence-not-instruction"
      || !Array.isArray(commit.parentObjectIds) || commit.parentObjectIds.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) {
      fail(`Git commit observation node is invalid: ${commit.nodeId}`, "INVALID_GIT_COMMIT_TEMPORAL_NODE");
    }
    if (!graph.edges.some((edge) => ((edge.type === "REFERENCES" && nodes.get(edge.from)?.kind === "VcsEvidence")
      || (edge.type === "AT_REVISION" && nodes.get(edge.from)?.kind === "BranchStateObservation")) && edge.to === commit.nodeId)) {
      fail(`Git commit observation is not referenced by VCS or branch-state evidence: ${commit.nodeId}`, "VCS_EVIDENCE_TEMPORAL_RELATION_MISSING");
    }
  }
  const documentDescriptor = (legacyV07 || legacyV08 || legacyV09 || legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? graph.documentChangeProjection : documentChangeProjectionDescriptor(null);
  if (!documentDescriptor || !["not-provided", "projected"].includes(documentDescriptor.status)) {
    fail("Temporal graph document-change projection descriptor is invalid.", "INVALID_DOCUMENT_CHANGE_TEMPORAL_PROJECTION");
  }
  for (const field of ["candidateSetIds", "reviewDecisionIds", "productModelRevisionIds", "applicationReceiptIds"]) {
    if (!Array.isArray(documentDescriptor[field]) || canonicalJson(documentDescriptor[field]) !== canonicalJson([...new Set(documentDescriptor[field])].sort())) {
      fail(`Temporal graph document-change ${field} must be sorted and unique.`, "INVALID_DOCUMENT_CHANGE_TEMPORAL_PROJECTION");
    }
  }
  if (documentDescriptor.status === "projected"
    && (!/^document-change-projection-[a-f0-9]{24}$/.test(documentDescriptor.projectionInputId || "") || !/^[a-f0-9]{64}$/.test(documentDescriptor.projectionInputHash || ""))) {
    fail("Temporal graph document-change projection identity is invalid.", "INVALID_DOCUMENT_CHANGE_TEMPORAL_PROJECTION");
  }
  const documentCandidateSets = graph.nodes.filter((node) => node.kind === "DocumentChangeCandidateSet");
  const documentCandidates = graph.nodes.filter((node) => node.kind === "DocumentChangeCandidate");
  const documentReviews = graph.nodes.filter((node) => node.kind === "DocumentChangeReviewDecision");
  const documentRevisions = graph.nodes.filter((node) => node.kind === "DocumentProductModelRevision");
  const documentApplications = graph.nodes.filter((node) => node.kind === "DocumentChangeApplication");
  const documentReferences = graph.nodes.filter((node) => node.kind === "DocumentProjectionReference");
  if (canonicalJson(idsOf(documentCandidateSets)) !== canonicalJson(documentDescriptor.candidateSetIds)
    || canonicalJson(idsOf(documentReviews)) !== canonicalJson(documentDescriptor.reviewDecisionIds)
    || canonicalJson(idsOf(documentRevisions)) !== canonicalJson(documentDescriptor.productModelRevisionIds)
    || canonicalJson(idsOf(documentApplications)) !== canonicalJson(documentDescriptor.applicationReceiptIds)) {
    fail(`Temporal graph document-change artifact sets do not match the projection descriptor: ${canonicalJson({
      actual: { candidateSetIds: idsOf(documentCandidateSets), reviewDecisionIds: idsOf(documentReviews), productModelRevisionIds: idsOf(documentRevisions), applicationReceiptIds: idsOf(documentApplications) },
      expected: documentDescriptor,
    })}`, "DOCUMENT_CHANGE_TEMPORAL_SET_MISMATCH");
  }
  const documentCandidateIds = new Set(idsOf(documentCandidates));
  for (const set of documentCandidateSets) {
    if (!/^[a-f0-9]{64}$/.test(set.candidateSetHash || "") || set.candidateIds.some((id) => !documentCandidateIds.has(id) || !hasEdge("CONTAINS", set.nodeId, id))
      || !graph.edges.some((edge) => edge.type === "PROPOSES_FROM" && edge.from === set.nodeId && nodes.get(edge.to)?.kind === "DocumentProjectionReference")) {
      fail(`Document-change candidate set projection is incomplete: ${set.nodeId}`, "DOCUMENT_CHANGE_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const review of documentReviews) {
    if (!documentDescriptor.candidateSetIds.includes(review.candidateSetId) || !hasEdge("REVIEWED_BY", review.candidateSetId, review.nodeId)) {
      fail(`Document-change review projection is incomplete: ${review.nodeId}`, "DOCUMENT_CHANGE_TEMPORAL_RELATION_MISSING");
    }
    for (const id of review.acceptedCandidateIds) if (!documentCandidateIds.has(id) || !hasEdge("ACCEPTED_BY", id, review.nodeId)) fail(`Document-change acceptance relation is missing: ${id}`, "DOCUMENT_CHANGE_TEMPORAL_RELATION_MISSING");
    for (const id of review.rejectedCandidateIds) if (!documentCandidateIds.has(id) || !hasEdge("REJECTED_BY", id, review.nodeId)) fail(`Document-change rejection relation is missing: ${id}`, "DOCUMENT_CHANGE_TEMPORAL_RELATION_MISSING");
  }
  for (const application of documentApplications) {
    if (!documentDescriptor.reviewDecisionIds.includes(application.reviewDecisionId)
      || !hasEdge("PRODUCES", application.reviewDecisionId, application.nodeId)
      || !graph.edges.some((edge) => edge.type === "PRODUCES" && edge.from === application.nodeId && nodes.get(edge.to)?.kind === "DocumentProjectionReference")) {
      fail(`Document-change application projection is incomplete: ${application.nodeId}`, "DOCUMENT_CHANGE_TEMPORAL_RELATION_MISSING");
    }
  }
  for (const reference of documentReferences) if (!/^document-projection-[a-f0-9]{24}$/.test(reference.documentProjectionId || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(reference.graphSnapshotId || "") || !/^source-snapshot-[a-f0-9]{24}$/.test(reference.referencedSourceSnapshotId || "")) {
    fail(`DocumentProjectionReference is invalid: ${reference.nodeId}`, "INVALID_DOCUMENT_CHANGE_TEMPORAL_NODE");
  }
  const observationDescriptor = legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION ? graph.observationProjection : observationProjectionDescriptor(null);
  if (!observationDescriptor || !["not-provided", "projected"].includes(observationDescriptor.status)) fail("Observation projection descriptor is invalid.", "INVALID_OBSERVATION_TEMPORAL_DESCRIPTOR");
  for (const field of ["descriptorIds", "observationIds", "derivedObservationIds", "receiptIds"]) {
    if (!Array.isArray(observationDescriptor[field]) || canonicalJson(observationDescriptor[field]) !== canonicalJson([...new Set(observationDescriptor[field])].sort())) fail(`Observation descriptor ${field} is invalid.`, "INVALID_OBSERVATION_TEMPORAL_DESCRIPTOR");
  }
  if (observationDescriptor.status === "projected" && (!/^observation-projection-[a-f0-9]{24}$/.test(observationDescriptor.projectionId || "") || !/^[a-f0-9]{64}$/.test(observationDescriptor.projectionHash || ""))) fail("Observation projection identity is invalid.", "INVALID_OBSERVATION_TEMPORAL_DESCRIPTOR");
  const observationTypeDescriptors = graph.nodes.filter((node) => node.kind === "ObservationTypeDescriptor");
  const observationReceipts = graph.nodes.filter((node) => node.kind === "ObservationCollectionReceipt");
  const observationRecords = graph.nodes.filter((node) => node.kind === "ObservationRecord");
  const derivedObservationRecords = graph.nodes.filter((node) => node.kind === "DerivedObservationRecord");
  for (const [values, field] of [[observationTypeDescriptors, "descriptorIds"], [observationReceipts, "receiptIds"], [observationRecords, "observationIds"], [derivedObservationRecords, "derivedObservationIds"]]) {
    if (canonicalJson(idsOf(values)) !== canonicalJson(observationDescriptor[field])) fail(`Observation projected ${field} does not match its descriptor.`, "OBSERVATION_TEMPORAL_SET_MISMATCH");
  }
  for (const observation of observationRecords) {
    if (observation.sourceAuthority !== "non-authoritative-observation-evidence"
      || !hasEdge("CONFORMS_TO", observation.nodeId, observation.descriptorId)
      || !graph.edges.some((edge) => edge.type === "EVIDENCED_BY" && edge.from === observation.nodeId && nodes.get(edge.to)?.kind === "ObservationCollectionReceipt")) fail("ObservationRecord projection lineage is incomplete.", "OBSERVATION_TEMPORAL_RELATION_MISSING");
    if (observation.typeKey === "delivery.state" && observation.payload?.revision_binding === "verified-source-revision") {
      const revisionEdges = graph.edges.filter((edge) => edge.type === "AT_REVISION" && edge.from === observation.nodeId);
      if (revisionEdges.length !== 1 || revisionEdges[0].to !== observation.payload.bound_revision_id) {
        fail("Verified delivery Observation lacks one exact source revision relation.", "DELIVERY_REVISION_REFERENCE_MISSING");
      }
    }
  }
  for (const observation of derivedObservationRecords) {
    if (observation.sourceAuthority !== "non-authoritative-derived-observation-evidence" || !hasEdge("CONFORMS_TO", observation.nodeId, observation.descriptorId)) fail("DerivedObservationRecord descriptor lineage is incomplete.", "OBSERVATION_TEMPORAL_RELATION_MISSING");
    const sourceIds = graph.edges.filter((edge) => edge.type === "DERIVED_FROM" && edge.from === observation.nodeId).map((edge) => edge.to).sort();
    if (!sourceIds.length || sourceIds.some((id) => nodes.get(id)?.kind !== "ObservationRecord")) fail("DerivedObservationRecord source lineage is incomplete.", "OBSERVATION_TEMPORAL_RELATION_MISSING");
  }
  const productOperatingDescriptor = (legacyV08 || legacyV09 || legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? graph.productOperatingProjection : productOperatingProjectionDescriptor(null);
  if (!productOperatingDescriptor || !["not-provided", "projected"].includes(productOperatingDescriptor.status)) fail("Product operating projection descriptor is invalid.", "INVALID_PRODUCT_OPERATING_TEMPORAL_DESCRIPTOR");
  for (const field of ["signalIds", "hypothesisIds", "initiativeCandidateIds", "reviewDecisionIds", "reviewedInitiativeIds", "featureCandidateIds", "outcomeObservationIds"]) {
    if (!Array.isArray(productOperatingDescriptor[field]) || canonicalJson(productOperatingDescriptor[field]) !== canonicalJson([...new Set(productOperatingDescriptor[field])].sort())) fail(`Product operating descriptor ${field} is invalid.`, "INVALID_PRODUCT_OPERATING_TEMPORAL_DESCRIPTOR");
  }
  if (productOperatingDescriptor.status === "projected" && (!/^product-operating-projection-[a-f0-9]{24}$/.test(productOperatingDescriptor.projectionInputId || "") || !/^[a-f0-9]{64}$/.test(productOperatingDescriptor.projectionInputHash || ""))) fail("Product operating projection identity is invalid.", "INVALID_PRODUCT_OPERATING_TEMPORAL_DESCRIPTOR");
  const operatingSignals = graph.nodes.filter((node) => node.kind === "ProductSignal");
  const operatingHypotheses = graph.nodes.filter((node) => node.kind === "ProductHypothesis");
  const operatingInitiativeCandidates = graph.nodes.filter((node) => node.kind === "ProductInitiativeCandidate");
  const operatingReviews = graph.nodes.filter((node) => node.kind === "ProductInitiativeReviewDecision");
  const operatingReviewedInitiatives = graph.nodes.filter((node) => node.kind === "ReviewedProductInitiative");
  const operatingFeatureCandidates = graph.nodes.filter((node) => node.kind === "ProductFeatureCandidate");
  const operatingOutcomes = graph.nodes.filter((node) => node.kind === "OutcomeObservation");
  const operatingSets = [[operatingSignals, "signalIds"], [operatingHypotheses, "hypothesisIds"], [operatingInitiativeCandidates, "initiativeCandidateIds"], [operatingReviews, "reviewDecisionIds"], [operatingReviewedInitiatives, "reviewedInitiativeIds"], [operatingFeatureCandidates, "featureCandidateIds"], [operatingOutcomes, "outcomeObservationIds"]];
  for (const [values, field] of operatingSets) if (canonicalJson(idsOf(values)) !== canonicalJson(productOperatingDescriptor[field])) fail(`Product operating projected ${field} does not match its descriptor.`, "PRODUCT_OPERATING_TEMPORAL_SET_MISMATCH");
  for (const hypothesis of operatingHypotheses) {
    const neutral = hypothesis.referenceSemantics === "neutral";
    if (Object.hasOwn(hypothesis, "referenceSemantics") && (!neutral || graphVersion !== TEMPORAL_PROVENANCE_VERSION)) fail("ProductHypothesis reference semantics are invalid.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
    const relation = neutral ? "REFERENCES" : "SUPPORTED_BY";
    const referenceIds = [...hypothesis.signalIds, ...((legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? hypothesis.observationIds : [])].sort();
    const referenceEdges = graph.edges.filter(edge => edge.from === hypothesis.nodeId && ["REFERENCES", "SUPPORTED_BY"].includes(edge.type));
    if (referenceEdges.some(edge => edge.type !== relation) || canonicalJson(referenceEdges.map(edge => edge.to).sort()) !== canonicalJson(referenceIds)) fail("ProductHypothesis exact evidence references or their semantics do not match.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
  }
  for (const candidate of operatingInitiativeCandidates) {
    for (const hypothesisId of candidate.hypothesisIds) if (!hasEdge("PROPOSES_FROM", candidate.nodeId, hypothesisId)) fail("Product Initiative hypothesis relation is missing.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
  }
  for (const review of operatingReviews) if (!hasEdge("REVIEWED_BY", review.initiativeCandidateId, review.nodeId) || !hasEdge(review.disposition === "accept" ? "ACCEPTED_BY" : "REJECTED_BY", review.initiativeCandidateId, review.nodeId)) fail("Product Initiative review relation is missing.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
  for (const initiative of operatingReviewedInitiatives) if (!hasEdge("PROMOTED_FROM", initiative.nodeId, initiative.initiativeCandidateId) || !hasEdge("PRODUCES", initiative.reviewDecisionId, initiative.nodeId)) fail("Reviewed Product Initiative lineage is missing.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
  for (const outcome of operatingOutcomes) if (!hasEdge("OBSERVES", outcome.nodeId, outcome.changeSetId)) fail("OutcomeObservation relation is missing.", "PRODUCT_OPERATING_TEMPORAL_RELATION_MISSING");
  const releaseDescriptor = (legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) ? graph.releaseObservationProjection : releaseObservationProjectionDescriptor(null);
  if (!releaseDescriptor || !["not-provided", "projected"].includes(releaseDescriptor.status)) fail("Release observation projection descriptor is invalid.", "INVALID_RELEASE_OBSERVATION_TEMPORAL_DESCRIPTOR");
  for (const field of ["branchStateObservationIds", "deploymentResultObservationIds", "releaseObservationIds"]) {
    if (!Array.isArray(releaseDescriptor[field]) || canonicalJson(releaseDescriptor[field]) !== canonicalJson([...new Set(releaseDescriptor[field])].sort())) fail(`Release observation descriptor ${field} is invalid.`, "INVALID_RELEASE_OBSERVATION_TEMPORAL_DESCRIPTOR");
  }
  if (releaseDescriptor.status === "projected" && (!/^release-observation-projection-[a-f0-9]{24}$/.test(releaseDescriptor.projectionInputId || "") || !/^[a-f0-9]{64}$/.test(releaseDescriptor.projectionInputHash || ""))) fail("Release observation projection identity is invalid.", "INVALID_RELEASE_OBSERVATION_TEMPORAL_DESCRIPTOR");
  const branchStateObservations = graph.nodes.filter((node) => node.kind === "BranchStateObservation");
  const deploymentResultObservations = graph.nodes.filter((node) => node.kind === "DeploymentResultObservation");
  const releaseObservations = graph.nodes.filter((node) => node.kind === "ReleaseObservation");
  const releaseSets = [[branchStateObservations, "branchStateObservationIds"], [deploymentResultObservations, "deploymentResultObservationIds"], [releaseObservations, "releaseObservationIds"]];
  for (const [values, field] of releaseSets) if (canonicalJson(idsOf(values)) !== canonicalJson(releaseDescriptor[field])) fail(`Release observation projected ${field} does not match its descriptor.`, "RELEASE_OBSERVATION_TEMPORAL_SET_MISMATCH");
  for (const branch of branchStateObservations) {
    if (!/^[a-f0-9]{64}$/.test(branch.branchStateObservationHash || "") || branch.vcsKind !== "git"
      || !["branch", "remote", "tag"].includes(branch.refKind) || !/^refs\/(?:heads|remotes|tags)\//.test(branch.ref || "")
      || !/^[a-f0-9]{40,64}$/.test(branch.commit || "") || !/^[a-f0-9]{64}$/.test(branch.referencesDigest || "")
      || branch.sourceAuthority !== "non-authoritative-branch-state-observation"
      || !graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === branch.nodeId && nodes.get(edge.to)?.kind === "GitCommit" && nodes.get(edge.to)?.objectId === branch.commit)) fail("BranchStateObservation projection is invalid.", "RELEASE_OBSERVATION_TEMPORAL_RELATION_MISSING");
  }
  for (const deployment of deploymentResultObservations) if (!/^[a-f0-9]{64}$/.test(deployment.deploymentResultObservationHash || "")
    || !["succeeded", "failed", "cancelled"].includes(deployment.status) || !/^[a-f0-9]{40,64}$/.test(deployment.commit || "")
    || typeof deployment.approved !== "boolean" || deployment.approved !== (deployment.approvalEvidenceDigest !== null)
    || !/^[a-f0-9]{64}$/.test(deployment.sourceEventKeyDigest || "") || !/^[a-f0-9]{64}$/.test(deployment.deploymentEvidenceDigest || "")
    || deployment.approvalEvidenceDigest !== null && !/^[a-f0-9]{64}$/.test(deployment.approvalEvidenceDigest || "")
    || deployment.sourceAuthority !== "non-authoritative-deployment-result-observation") fail("DeploymentResultObservation projection is invalid.", "INVALID_RELEASE_OBSERVATION_TEMPORAL_NODE");
  for (const release of releaseObservations) {
    const deployment = nodes.get(release.deploymentResultObservationId);
    if (!/^[a-f0-9]{64}$/.test(release.releaseObservationHash || "") || release.sourceAuthority !== "non-authoritative-release-observation"
      || deployment?.kind !== "DeploymentResultObservation" || deployment.status !== "succeeded" || deployment.approved !== true
      || deployment.commit !== release.commit || deployment.environmentKey !== release.environmentKey
      || !hasEdge("EVIDENCED_BY", release.nodeId, release.deploymentResultObservationId)
      || !graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === release.nodeId && nodes.get(edge.to)?.kind === "GitCommit" && nodes.get(edge.to)?.objectId === release.commit)) fail("ReleaseObservation evidence or revision relation is missing.", "RELEASE_OBSERVATION_TEMPORAL_RELATION_MISSING");
    for (const branchId of release.branchStateObservationIds) if (nodes.get(branchId)?.kind !== "BranchStateObservation" || nodes.get(branchId)?.commit !== release.commit || !hasEdge("OBSERVED_ON", release.nodeId, branchId)) fail("ReleaseObservation branch relation is missing.", "RELEASE_OBSERVATION_TEMPORAL_RELATION_MISSING");
    if (release.changeSetId && !hasEdge("DEPLOYS", release.nodeId, release.changeSetId)) fail("ReleaseObservation ChangeSet relation is missing.", "RELEASE_OBSERVATION_TEMPORAL_RELATION_MISSING");
  }
  const productLogical = new Map();
  for (const kind of Object.keys(PRODUCT_DEFINITIONS)) {
    for (const node of graph.nodes.filter((candidate) => candidate.kind === kind)) productLogical.set(`${kind}:${node.key}`, node.nodeId);
  }
  for (const featureGroupRevision of graph.nodes.filter((node) => node.kind === "FeatureGroupRevision")) {
    for (const parentKey of featureGroupRevision.semantic.parentFeatureGroupKeys) {
      if (!hasEdge("CONTAINS", productLogical.get(`FeatureGroup:${parentKey}`), featureGroupRevision.logicalEntityId)) {
        fail(`FeatureGroup relation is missing for ${featureGroupRevision.key}.`, "PRODUCT_RELATION_MISSING");
      }
    }
  }
  for (const featureRevision of graph.nodes.filter((node) => node.kind === "FeatureRevision")) {
    for (const groupKey of featureRevision.semantic.featureGroupKeys) {
      if (!hasEdge("CONTAINS", productLogical.get(`FeatureGroup:${groupKey}`), featureRevision.logicalEntityId)) {
        fail(`FeatureGroup containment is missing for ${featureRevision.key}.`, "PRODUCT_RELATION_MISSING");
      }
    }
    for (const capabilityKey of featureRevision.semantic.capabilityKeys) {
      if (!hasEdge("REALIZES", featureRevision.logicalEntityId, productLogical.get(`Capability:${capabilityKey}`))) {
        fail(`Capability realization is missing for ${featureRevision.key}.`, "PRODUCT_RELATION_MISSING");
      }
    }
    for (const governed of featureRevision.semantic.governedBy) {
      if (!hasEdge("GOVERNED_BY", featureRevision.logicalEntityId, productLogical.get(`${governed.kind}:${governed.key}`))) {
        fail(`Governance relation is missing for ${featureRevision.key}.`, "PRODUCT_RELATION_MISSING");
      }
    }
  }
  for (const policyRevision of graph.nodes.filter((node) => node.kind === "PolicyRevision")) {
    if (policyRevision.semantic.status === "active") {
      for (const application of policyRevision.semantic.appliesTo) {
        if (!hasEdge("GOVERNED_BY", productLogical.get(`${application.kind}:${application.key}`), policyRevision.logicalEntityId)) {
          fail(`Policy application is missing for ${policyRevision.key}.`, "PRODUCT_RELATION_MISSING");
        }
      }
    }
    for (const governed of policyRevision.semantic.governedBy) {
      if (!hasEdge("GOVERNED_BY", policyRevision.logicalEntityId, productLogical.get(`${governed.kind}:${governed.key}`))) {
        fail(`Policy semantic reference is missing for ${policyRevision.key}.`, "PRODUCT_RELATION_MISSING");
      }
    }
  }
  const expectedProductRelations = new Set();
  const addExpectedProductRelation = (type, from, to) => expectedProductRelations.add(`${type}|${from}|${to}`);
  for (const revision of graph.nodes.filter((node) => productRevisionKinds.includes(node.kind))) {
    addExpectedProductRelation("HAS_REVISION", revision.logicalEntityId, revision.nodeId);
    addExpectedProductRelation("CURRENT_REVISION", revision.logicalEntityId, revision.nodeId);
    addExpectedProductRelation("CONTAINS", graph.sourceSnapshotId, revision.nodeId);
  }
  for (const featureGroupRevision of graph.nodes.filter((node) => node.kind === "FeatureGroupRevision")) {
    for (const parentKey of featureGroupRevision.semantic.parentFeatureGroupKeys) {
      addExpectedProductRelation("CONTAINS", productLogical.get(`FeatureGroup:${parentKey}`), featureGroupRevision.logicalEntityId);
    }
  }
  for (const featureRevision of graph.nodes.filter((node) => node.kind === "FeatureRevision")) {
    for (const groupKey of featureRevision.semantic.featureGroupKeys) {
      addExpectedProductRelation("CONTAINS", productLogical.get(`FeatureGroup:${groupKey}`), featureRevision.logicalEntityId);
    }
    for (const capabilityKey of featureRevision.semantic.capabilityKeys) {
      addExpectedProductRelation("REALIZES", featureRevision.logicalEntityId, productLogical.get(`Capability:${capabilityKey}`));
    }
    for (const governed of featureRevision.semantic.governedBy) {
      addExpectedProductRelation("GOVERNED_BY", featureRevision.logicalEntityId, productLogical.get(`${governed.kind}:${governed.key}`));
    }
  }
  for (const policyRevision of graph.nodes.filter((node) => node.kind === "PolicyRevision")) {
    if (policyRevision.semantic.status === "active") {
      for (const application of policyRevision.semantic.appliesTo) {
        addExpectedProductRelation("GOVERNED_BY", productLogical.get(`${application.kind}:${application.key}`), policyRevision.logicalEntityId);
      }
    }
    for (const governed of policyRevision.semantic.governedBy) {
      addExpectedProductRelation("GOVERNED_BY", policyRevision.logicalEntityId, productLogical.get(`${governed.kind}:${governed.key}`));
    }
  }
  const productNodeKinds = new Set([...Object.keys(PRODUCT_DEFINITIONS), ...productRevisionKinds]);
  const actualProductRelations = graph.edges.filter((edge) => {
    const fromKind = nodes.get(edge.from)?.kind;
    const toKind = nodes.get(edge.to)?.kind;
    return ["REALIZES", "GOVERNED_BY"].includes(edge.type)
      || (edge.type === "CONTAINS" && (productNodeKinds.has(fromKind) || productNodeKinds.has(toKind)))
      || (["HAS_REVISION", "CURRENT_REVISION"].includes(edge.type) && productNodeKinds.has(fromKind));
  });
  const actualProductRelationSet = new Set(actualProductRelations.map((edge) => `${edge.type}|${edge.from}|${edge.to}`));
  if (canonicalJson([...actualProductRelationSet].sort()) !== canonicalJson([...expectedProductRelations].sort())) {
    fail("Product relation projection does not match product canon.", "PRODUCT_RELATION_SET_MISMATCH");
  }
  if (actualProductRelations.some((edge) => edge.authorityClass !== "canon-projected" || edge.origin !== "project-product-canon")) {
    fail("Product relations have invalid projection authority.", "INVALID_PRODUCT_PROJECTION_AUTHORITY");
  }
  const summary = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    fileCount: graph.nodes.filter((node) => node.kind === "File").length,
    fileRevisionCount: graph.nodes.filter((node) => node.kind === "FileRevision").length,
    symbolCount: graph.nodes.filter((node) => node.kind === "Symbol").length,
    symbolRevisionCount: graph.nodes.filter((node) => node.kind === "SymbolRevision").length,
    testCount: graph.nodes.filter((node) => node.kind === "Test").length,
    testRevisionCount: graph.nodes.filter((node) => node.kind === "TestRevision").length,
    featureGroupCount: graph.nodes.filter((node) => node.kind === "FeatureGroup").length,
    capabilityCount: graph.nodes.filter((node) => node.kind === "Capability").length,
    featureCount: graph.nodes.filter((node) => node.kind === "Feature").length,
    requirementCount: graph.nodes.filter((node) => node.kind === "Requirement").length,
    constraintCount: graph.nodes.filter((node) => node.kind === "Constraint").length,
    decisionCount: graph.nodes.filter((node) => node.kind === "Decision").length,
    productRevisionCount: actualProductRevisionIds.length,
    sourceParentCount: graph.parentSourceSnapshotIds.length,
    revisionParentCount: Object.values(actualRevisionParentIds).reduce((count, values) => count + values.length, 0),
  };
  if (!legacyV02) Object.assign(summary, {
    onboardingCandidateSetCount: onboardingCandidateSets.length,
    onboardingCandidateCount: onboardingCandidates.length,
    onboardingEvidenceCount: onboardingEvidence.length,
    onboardingUnknownCount: onboardingUnknowns.length,
    onboardingReviewDecisionCount: onboardingReviews.length,
    onboardingAcceptedCandidateCount: acceptedCandidateCount,
    onboardingRejectedCandidateCount: rejectedCandidateCount,
    productModelRevisionReceiptCount: productModelRevisions.length,
  });
  if (graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    historicalOnboardingReferenceCount: graph.nodes.filter((node) => node.kind === "HistoricalOnboardingCandidateReference").length,
    historicalContinuityCount: graph.edges.filter((edge) => edge.type === "HISTORICALLY_FOLLOWS").length,
  });
  if (legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    productPolicyCandidateCount: policyCandidates.length,
    productPolicyEvidenceCount: policyEvidence.length,
    productPolicyReviewDecisionCount: policyReviews.length,
    appliedProductPolicyDecisionCount: policyCandidates.filter((node) => node.applicationStatus.startsWith("applied-")).length,
  });
  if (!legacyV02 && !legacyV03) Object.assign(summary, {
    featureMappingCandidateSetCount: mappingCandidateSets.length,
    featureMappingCandidateCount: mappingCandidates.length,
    featureMappingEvidenceCount: mappingEvidence.length,
    featureMappingUnknownCount: mappingUnknowns.length,
    featureMappingReviewDecisionCount: mappingReviews.length,
    featureMappingAcceptedCandidateCount: mappingAcceptedCandidateCount,
    featureMappingRejectedCandidateCount: mappingRejectedCandidateCount,
    reviewedRelationshipCount: reviewedRelationships.length,
    activeReviewedRelationshipCount: reviewedRelationships.filter((node) => node.projectionStatus === "current").length,
  });
  if (!legacyV02 && !legacyV03 && !legacyV04) Object.assign(summary, {
    changeSetCount: changeSets.length,
    changeRecordCount: changeSets.reduce((count, node) => count + node.changeIds.length, 0),
    changeImpactCandidateSetCount: changeCandidateSets.length,
    changeImpactCandidateCount: changeCandidates.length,
    changeImpactUnknownCount: changeUnknowns.length,
    changeImpactReviewDecisionCount: changeReviews.length,
    changeImpactAcceptedCandidateCount: changeAcceptedCandidateCount,
    changeImpactRejectedCandidateCount: changeRejectedCandidateCount,
    reviewedImpactCount: reviewedImpacts.length,
    activeReviewedImpactCount: reviewedImpacts.filter((node) => node.projectionStatus === "current").length,
  });
  if (!legacyV02 && !legacyV03 && !legacyV04 && !legacyV05) Object.assign(summary, {
    vcsEvidenceCount: vcsEvidenceNodes.length,
    gitCommitObservationCount: gitCommitNodes.length,
  });
  if (legacyV07 || legacyV08 || legacyV09 || legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    documentChangeCandidateSetCount: documentCandidateSets.length,
    documentChangeCandidateCount: documentCandidates.length,
    documentChangeReviewDecisionCount: documentReviews.length,
    documentChangeProductModelRevisionCount: documentRevisions.length,
    documentChangeApplicationCount: documentApplications.length,
    documentProjectionReferenceCount: documentReferences.length,
  });
  if (legacyV08 || legacyV09 || legacyV10 || legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    productSignalCount: operatingSignals.length,
    productHypothesisCount: operatingHypotheses.length,
    productInitiativeCandidateCount: operatingInitiativeCandidates.length,
    productInitiativeReviewDecisionCount: operatingReviews.length,
    reviewedProductInitiativeCount: operatingReviewedInitiatives.length,
    productFeatureCandidateCount: operatingFeatureCandidates.length,
    outcomeObservationCount: operatingOutcomes.length,
  });
  if (legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    observationTypeDescriptorCount: observationTypeDescriptors.length,
    observationCollectionReceiptCount: observationReceipts.length,
    observationRecordCount: observationRecords.length,
    derivedObservationRecordCount: derivedObservationRecords.length,
  });
  if (legacyV11 || legacyV12 || legacyV13 || legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) Object.assign(summary, {
    branchStateObservationCount: branchStateObservations.length,
    deploymentResultObservationCount: deploymentResultObservations.length,
    releaseObservationCount: releaseObservations.length,
  });
  if (legacyV14 || graphVersion === TEMPORAL_PROVENANCE_VERSION) summary.policyCount = graph.nodes.filter((node) => node.kind === "Policy").length;
  if (canonicalJson(summary) !== canonicalJson(graph.summary)) {
    fail(`Temporal graph summary does not match its contents: expected ${canonicalJson(summary)}, received ${canonicalJson(graph.summary)}.`, "TEMPORAL_SUMMARY_MISMATCH");
  }
  if (owned?.state.active) owned.verified = true;
  return graph;
}

function normalizeAllowlist(values, supported, label) {
  const source = values == null ? [...supported] : Array.isArray(values) ? values : [values];
  const normalized = sortedUniqueStrings(source, label);
  for (const value of normalized) if (!supported.includes(value)) fail(`${label} contains unsupported value: ${value}`, "INVALID_TEMPORAL_QUERY_ALLOWLIST");
  return normalized;
}

function searchable(node) {
  return [node.nodeId, node.kind, node.path, node.name, node.symbolKind, node.classification, node.language,
    node.key, node.logicalEntityId, node.fileId, node.fileRevisionId, node.referencedSourceSnapshotId, node.referencedRevisionId,
    node.productKind, node.inputMode, node.sourceKind, node.disposition, node.statement, node.explanation, node.rationale,
    node.changeSetId, node.changeId, node.targetNodeId, node.targetKind, node.resultPacketId, node.executionReviewDecisionId,
    node.vcsKind, node.objectId, node.subject, node.body, node.authorName, node.gitHistoryId, node.relativePath,
    node.ref, node.refKind, node.environmentKey, node.status, node.commit, node.deploymentResultObservationId,
    node.policyKey, node.applicationStatus, node.reference, node.referencedProductModelId,
    node.semantic ? canonicalJson(node.semantic) : ""]
    .filter(Boolean).join(" ").toLocaleLowerCase();
}

export function queryTemporalProvenanceGraph(graph, {
  query = null,
  anchorIds = null,
  expectedGraphSnapshotId = null,
  kinds = null,
  relations = null,
  authorityClasses = ["canon-projected", "reviewed", "derived", "heuristic", "runtime-observed"],
  freshness = ["current"],
  minConfidence = 0,
  includeUnreviewedCandidates = false,
  depth = 1,
  maxNodes = 100,
  maxEdges = 200,
  eligibility = null,
} = {}) {
  verifyTemporalProvenanceGraph(graph);
  const format = familyFormatForOriginal("head-agent-core-temporal-provenance", graph);
  const originalNodeIds = eligibility ? new Set(graph.nodes.map(node => node.nodeId)) : null;
  const originalEdgeIds = eligibility ? new Set(graph.edges.map(edge => edge.edgeId)) : null;
  if (eligibility && (eligibility.graphSnapshotId !== graph.graphSnapshotId || eligibility.graphSnapshotHash !== graph.graphSnapshotHash
    || !Array.isArray(eligibility.nodeIds) || !Array.isArray(eligibility.edgeIds)
    || new Set(eligibility.nodeIds).size !== eligibility.nodeIds.length || new Set(eligibility.edgeIds).size !== eligibility.edgeIds.length
    || eligibility.nodeIds.some(id => !originalNodeIds.has(id))
    || eligibility.edgeIds.some(id => !originalEdgeIds.has(id)))) {
    fail("Domain eligibility must refer to the original verified GraphSnapshot.", "TEMPORAL_ELIGIBILITY_SNAPSHOT_MISMATCH");
  }
  const eligibleDomainNodes = eligibility ? new Set(eligibility.nodeIds) : null;
  const eligibleDomainEdges = eligibility ? new Set(eligibility.edgeIds) : null;
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const exactAnchorIds = anchorIds == null ? [] : anchorIds;
  if (!Array.isArray(exactAnchorIds)
    || exactAnchorIds.some((nodeId) => typeof nodeId !== "string" || !nodeId.trim() || nodeId.length > 256)) {
    fail("Temporal exact anchorIds must be bounded non-empty strings.", "INVALID_TEMPORAL_EXACT_ANCHORS");
  }
  if (exactAnchorIds.length > 32 || new Set(exactAnchorIds).size !== exactAnchorIds.length) {
    fail("Temporal exact anchorIds must be unique and contain at most 32 entries.", "INVALID_TEMPORAL_EXACT_ANCHORS");
  }
  const exactAnchorMode = exactAnchorIds.length > 0;
  if (exactAnchorMode && normalizedQuery) fail("Temporal traversal accepts either query or exact anchorIds, not both.", "AMBIGUOUS_TEMPORAL_ANCHOR_MODE");
  if (!exactAnchorMode && !normalizedQuery) fail("Temporal graph query or exact anchorIds are required.", "TEMPORAL_QUERY_REQUIRED");
  if (exactAnchorMode && (!expectedGraphSnapshotId || expectedGraphSnapshotId !== graph.graphSnapshotId)) {
    fail("Temporal exact anchors must bind to the current GraphSnapshot.", "TEMPORAL_GRAPH_SNAPSHOT_MISMATCH");
  }
  const allowedKinds = normalizeAllowlist(kinds, TEMPORAL_NODE_KINDS, "kinds");
  const allowedRelations = normalizeAllowlist(relations, TEMPORAL_RELATION_TYPES, "relations");
  const allowedAuthorityClasses = normalizeAllowlist(authorityClasses, [...AUTHORITY_CLASSES], "authorityClasses");
  const allowedFreshness = normalizeAllowlist(freshness, [...FRESHNESS_STATES], "freshness");
  const safeDepth = Number(depth);
  const safeMaxNodes = Number(maxNodes);
  const safeMaxEdges = Number(maxEdges);
  const safeMinimumConfidence = Number(minConfidence);
  if (!Number.isInteger(safeDepth) || safeDepth < 0 || safeDepth > 3) fail("Temporal traversal depth must be from 0 to 3.", "INVALID_TEMPORAL_QUERY_DEPTH");
  if (!Number.isInteger(safeMaxNodes) || safeMaxNodes < 1 || safeMaxNodes > 500) fail("Temporal traversal maxNodes must be from 1 to 500.", "INVALID_TEMPORAL_QUERY_NODE_LIMIT");
  if (!Number.isInteger(safeMaxEdges) || safeMaxEdges < 0 || safeMaxEdges > 1000) fail("Temporal traversal maxEdges must be from 0 to 1000.", "INVALID_TEMPORAL_QUERY_EDGE_LIMIT");
  if (!Number.isFinite(safeMinimumConfidence) || safeMinimumConfidence < 0 || safeMinimumConfidence > 1) fail("Temporal traversal minConfidence must be from zero through one.", "INVALID_TEMPORAL_QUERY_CONFIDENCE");
  if (typeof includeUnreviewedCandidates !== "boolean") fail("includeUnreviewedCandidates must be boolean.", "INVALID_TEMPORAL_QUERY_CANDIDATE_POLICY");

  const confidenceOf = (record) => record.confidence == null ? 1 : record.confidence;
  const candidateSurfaceKinds = new Set([
    "OnboardingCandidateSet", "OnboardingProductCandidate", "OnboardingEvidence", "OnboardingUnknown", "ProductConceptReference",
    "FeatureMappingCandidateSet", "FeatureMappingCandidate", "FeatureMappingEvidence", "FeatureMappingUnknown", "MappingEndpointReference",
    "ChangeImpactCandidateSet", "ChangeImpactCandidate", "ChangeImpactUnknown", "ChangeProductReference",
    "DocumentChangeCandidateSet", "DocumentChangeCandidate",
    "ProductInitiativeCandidate", "ProductFeatureCandidate", "ProductPolicyCandidate", "ProductPolicyEvidence",
  ]);
  const candidatePolicyAllows = (record) => includeUnreviewedCandidates || !candidateSurfaceKinds.has(record.kind);
  const nodeEligible = (node) => allowedKinds.includes(node.kind) && allowedAuthorityClasses.includes(node.authorityClass)
    && allowedFreshness.includes(node.freshness) && confidenceOf(node) >= safeMinimumConfidence && candidatePolicyAllows(node)
    && (!eligibleDomainNodes || eligibleDomainNodes.has(node.nodeId));
  const edgeEligible = (edge) => allowedRelations.includes(edge.type) && allowedAuthorityClasses.includes(edge.authorityClass)
    && allowedFreshness.includes(edge.freshness) && confidenceOf(edge) >= safeMinimumConfidence
    && (!eligibleDomainEdges || eligibleDomainEdges.has(edge.edgeId));
  const eligibleNodes = graph.nodes.filter(nodeEligible);
  const eligibleNodeIds = new Set(eligibleNodes.map((node) => node.nodeId));
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const normalizedExactAnchorIds = [...exactAnchorIds].sort();
  if (exactAnchorMode) {
    const missing = normalizedExactAnchorIds.filter((nodeId) => !nodesById.has(nodeId));
    if (missing.length) fail(`Temporal exact anchors are absent from the current GraphSnapshot: ${missing.join(", ")}`, "TEMPORAL_EXACT_ANCHOR_NOT_FOUND");
    const ineligible = normalizedExactAnchorIds.filter((nodeId) => !eligibleNodeIds.has(nodeId));
    if (ineligible.length) fail(`Temporal exact anchors are outside the requested authority, freshness, scope, or candidate policy: ${ineligible.join(", ")}`, "TEMPORAL_EXACT_ANCHOR_INELIGIBLE");
  }
  const matching = exactAnchorMode
    ? normalizedExactAnchorIds.map((nodeId) => nodesById.get(nodeId))
    : eligibleNodes.filter((node) => searchable(node).includes(normalizedQuery));
  if (exactAnchorMode && matching.length > safeMaxNodes) fail("Temporal exact anchors exceed maxNodes.", "TEMPORAL_EXACT_ANCHOR_LIMIT");
  const anchors = matching.slice(0, safeMaxNodes);
  const selected = new Set(anchors.map((node) => node.nodeId));
  const inclusionReasons = new Map(anchors.map((node) => [node.nodeId, exactAnchorMode ? format.value("exact-head-anchor") : "lexical-discovery-match"]));
  let frontier = new Set(selected);
  const selectedEdges = [];
  const selectedEdgeIds = new Set();
  const nodeLimitExcludedIds = new Set(matching.slice(anchors.length).map((node) => node.nodeId));
  const edgeLimitExcludedIds = new Set();
  const boundaryItems = [];
  const addBoundary = (edge, omittedNodeId, selectedNodeId, reason) => {
    const key = `${edge?.edgeId || "anchor"}:${omittedNodeId || ""}:${reason}`;
    if (boundaryItems.some((item) => item.key === key)) return;
    boundaryItems.push({ key, edgeId: edge?.edgeId || null, relationType: edge?.type || null,
      selectedNodeId: selectedNodeId || null, omittedNodeId: omittedNodeId || null,
      nextAnchorId: omittedNodeId || null, reason });
  };
  for (const node of matching.slice(anchors.length)) addBoundary(null, node.nodeId, null, "anchor-node-limit");
  const eligibleEdges = graph.edges.filter((edge) => edgeEligible(edge) && eligibleNodeIds.has(edge.from) && eligibleNodeIds.has(edge.to));
  for (let level = 0; level < safeDepth && frontier.size; level += 1) {
    const next = new Set();
    for (const edge of eligibleEdges) {
      if (!frontier.has(edge.from) && !frontier.has(edge.to)) continue;
      if (selectedEdgeIds.has(edge.edgeId)) continue;
      const missing = [edge.from, edge.to].filter((nodeId) => !selected.has(nodeId) && !next.has(nodeId));
      if (selected.size + next.size + missing.length > safeMaxNodes) {
        for (const nodeId of missing) {
          nodeLimitExcludedIds.add(nodeId);
          addBoundary(edge, nodeId, edge.from === nodeId ? edge.to : edge.from, "node-limit");
        }
        continue;
      }
      if (selectedEdges.length >= safeMaxEdges) {
        edgeLimitExcludedIds.add(edge.edgeId);
        const omittedNodeId = missing[0] || null;
        addBoundary(edge, omittedNodeId, omittedNodeId === edge.from ? edge.to : edge.from, "edge-limit");
        continue;
      }
      for (const nodeId of missing) {
        next.add(nodeId);
        inclusionReasons.set(nodeId, `traversed-depth-${level + 1}`);
      }
      selectedEdges.push(edge);
      selectedEdgeIds.add(edge.edgeId);
    }
    for (const nodeId of next) selected.add(nodeId);
    frontier = next;
  }
  if (safeDepth >= 0 && frontier.size) for (const edge of eligibleEdges) {
    if (selectedEdgeIds.has(edge.edgeId) || (!frontier.has(edge.from) && !frontier.has(edge.to))) continue;
    const omittedNodeId = !selected.has(edge.from) ? edge.from : !selected.has(edge.to) ? edge.to : null;
    if (omittedNodeId) addBoundary(edge, omittedNodeId, edge.from === omittedNodeId ? edge.to : edge.from, "depth-limit");
  }
  const nodes = graph.nodes.filter((node) => selected.has(node.nodeId));
  selectedEdges.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  boundaryItems.sort((left, right) => compareText(left.reason, right.reason)
    || compareText(left.edgeId || "", right.edgeId || "") || compareText(left.omittedNodeId || "", right.omittedNodeId || ""));
  const boundaryLimit = 100;
  const boundedBoundaryItems = boundaryItems.slice(0, boundaryLimit).map(({ key, ...item }) => item);
  const traversalQuery = {
    anchorMode: exactAnchorMode ? format.value("exact-head-proposed") : "lexical-discovery",
    normalizedQuery,
    anchorIds: anchors.map((node) => node.nodeId),
    expectedGraphSnapshotId: exactAnchorMode ? graph.graphSnapshotId : null,
    allowedKinds,
    allowedRelations,
    allowedAuthorityClasses,
    allowedFreshness,
    minConfidence: safeMinimumConfidence,
    includeUnreviewedCandidates,
    maxDepth: safeDepth,
    maxNodes: safeMaxNodes,
    maxEdges: safeMaxEdges,
    ordering: "nodeId-then-edgeId-ascending",
    ...(eligibility ? { domainEligibilityHash: digest(canonicalJson(eligibility)) } : {}),
  };
  const queryHash = digest(canonicalJson(traversalQuery));
  const resultPayload = {
    kind: "TemporalTraversalResult",
    protocol: { name: format.protocol("head-agent-core-temporal-traversal"), version: TEMPORAL_TRAVERSAL_VERSION },
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    traversalQuery,
    queryId: `traversal-query-${queryHash.slice(0, 24)}`,
    queryHash,
    nodes,
    edges: selectedEdges,
    inclusion: nodes.map((node) => ({ nodeId: node.nodeId, reason: inclusionReasons.get(node.nodeId) || "connected-selected-endpoint" })),
    exclusion: {
      unmatchedNodeCount: exactAnchorMode ? 0 : graph.nodes.filter((node) => nodeEligible(node) && !searchable(node).includes(normalizedQuery) && !selected.has(node.nodeId)).length,
      disallowedNodeCount: graph.nodes.filter((node) => !nodeEligible(node)).length,
      disallowedEdgeCount: graph.edges.filter((edge) => !edgeEligible(edge)).length,
      nodeLimitExcluded: nodeLimitExcludedIds.size,
      edgeLimitExcluded: edgeLimitExcludedIds.size,
      unreviewedCandidatesExcluded: graph.nodes.filter((node) => candidateSurfaceKinds.has(node.kind) && !includeUnreviewedCandidates).length,
      ...(eligibility ? { domainExcludedNodes: graph.nodes.length - eligibleDomainNodes.size,
        domainExcludedEdges: graph.edges.length - eligibleDomainEdges.size, domainFreshness: eligibility.domains } : {}),
    },
    boundary: {
      items: boundedBoundaryItems,
      omittedItemCount: Math.max(0, boundaryItems.length - boundedBoundaryItems.length),
      nextAnchorIds: [...new Set(boundaryItems.map((item) => item.nextAnchorId).filter(Boolean))].sort().slice(0, boundaryLimit),
      complete: boundaryItems.length === 0,
    },
    truncated: boundaryItems.length > 0,
    authority: "derived-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const resultHash = digest(canonicalJson(resultPayload));
  const result = { ...resultPayload, resultId: `traversal-result-${resultHash.slice(0, 24)}`, resultHash };
  // A request-owned input must not make ordinary returned projections frozen.
  return ownedTemporalGraphs.has(graph) ? structuredClone(result) : result;
}
