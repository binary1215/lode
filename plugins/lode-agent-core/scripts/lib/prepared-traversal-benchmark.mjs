import crypto from "node:crypto";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import {
  buildPreparedTraversalRequest,
  graphProjectionCanonicalJson,
  verifyPreparedTraversalRequest,
} from "./graph-projection-adapter.mjs";
import { queryTemporalProvenanceGraph, verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";

export const PREPARED_TRAVERSAL_COST_VERSION = "0.1.0";

const fail = (message, code = "PREPARED_TRAVERSAL_COST_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(graphProjectionCanonicalJson(value), "utf8");

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid.`, "INVALID_PREPARED_TRAVERSAL_COST_EVIDENCE");
  const expected = new Set(fields);
  if (Object.keys(value).some((field) => !expected.has(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_PREPARED_TRAVERSAL_COST_EVIDENCE");
  }
}

function traversalOptions(query) {
  return {
    query: query.normalizedQuery,
    kinds: [...query.allowedKinds],
    relations: [...query.allowedRelations],
    authorityClasses: [...query.allowedAuthorityClasses],
    freshness: [...query.allowedFreshness],
    minConfidence: query.minConfidence,
    includeUnreviewedCandidates: query.includeUnreviewedCandidates,
    depth: query.maxDepth,
    maxNodes: query.maxNodes,
    maxEdges: query.maxEdges,
  };
}

function evidencePayload({ graph, request, storage = null }) {
  const format = formatForVerifiedOwner(storage);
  verifyTemporalProvenanceGraph(graph);
  const prepared = verifyPreparedTraversalRequest(request);
  const result = queryTemporalProvenanceGraph(graph, traversalOptions(prepared.traversalQuery));
  const expected = buildPreparedTraversalRequest({ graph, result, storage });
  if (graphProjectionCanonicalJson(prepared) !== graphProjectionCanonicalJson(expected)) {
    fail("Prepared traversal cost evidence requires the exact deterministic graph request.", "PREPARED_TRAVERSAL_COST_REQUEST_MISMATCH");
  }

  const identityEnvelope = {
    projectId: prepared.projectId,
    graphSnapshotId: prepared.graphSnapshotId,
    graphSnapshotHash: prepared.graphSnapshotHash,
    sourceSnapshotId: prepared.sourceSnapshotId,
    queryId: prepared.queryId,
    queryHash: prepared.queryHash,
    resultId: prepared.resultId,
    resultHash: prepared.resultHash,
    requestId: prepared.requestId,
    requestHash: prepared.requestHash,
  };
  const components = {
    identityEnvelopeBytes: bytes(identityEnvelope),
    graphManifestBytes: bytes(prepared.graphManifest),
    boundedExpansionBytes: bytes(prepared.expansion),
    graphSnapshotBytes: bytes(graph),
    fullTopologyRecordsBytes: bytes({ nodes: graph.nodes, edges: graph.edges }),
  };
  const preparedQueryBytes = components.identityEnvelopeBytes
    + components.graphManifestBytes
    + components.boundedExpansionBytes;
  const fullReloadBaselineBytes = preparedQueryBytes
    + components.graphSnapshotBytes
    + components.fullTopologyRecordsBytes;
  const savedBytes = fullReloadBaselineBytes - preparedQueryBytes;
  return {
    schemaVersion: 1,
    kind: "PreparedTraversalCostEvidence",
    protocol: { name: format.protocol("head-agent-core-prepared-traversal-cost"), version: PREPARED_TRAVERSAL_COST_VERSION },
    payloadModel: "normalized-utf8-canonical-json-response-components",
    projectId: prepared.projectId,
    graphSnapshotId: prepared.graphSnapshotId,
    graphSnapshotHash: prepared.graphSnapshotHash,
    sourceSnapshotId: prepared.sourceSnapshotId,
    requestId: prepared.requestId,
    requestHash: prepared.requestHash,
    queryId: prepared.queryId,
    queryHash: prepared.queryHash,
    resultId: prepared.resultId,
    resultHash: prepared.resultHash,
    expansionHash: prepared.expansionHash,
    graphManifestHash: prepared.graphManifest.graphManifestHash,
    nodeCount: prepared.graphManifest.nodeCount,
    edgeCount: prepared.graphManifest.edgeCount,
    expansionNodeCount: prepared.expansion.nodeCount,
    expansionEdgeCount: prepared.expansion.edgeCount,
    components,
    preparedQueryBytes,
    fullReloadBaselineBytes,
    savedBytes,
    reductionBasisPoints: fullReloadBaselineBytes === 0 ? 0 : Math.floor((savedBytes * 10000) / fullReloadBaselineBytes),
    authority: "derived-performance-evidence-only",
    semanticIdentityEffect: "none",
    instructionAuthority: false,
    promotionAuthority: false,
  };
}

export function buildPreparedTraversalCostEvidence({ graph, request, storage = null } = {}) {
  const payload = evidencePayload({ graph, request, storage });
  const evidenceHash = digest(graphProjectionCanonicalJson(payload));
  return verifyPreparedTraversalCostEvidence({
    ...payload,
    evidenceId: `prepared-traversal-cost-${evidenceHash.slice(0, 24)}`,
    evidenceHash,
  });
}

export function verifyPreparedTraversalCostEvidence(document, { graph = null, request = null } = {}) {
  const format = familyFormatForOriginal("head-agent-core-prepared-traversal-cost", document);
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "payloadModel", "projectId", "graphSnapshotId", "graphSnapshotHash",
    "sourceSnapshotId", "requestId", "requestHash", "queryId", "queryHash", "resultId", "resultHash",
    "expansionHash", "graphManifestHash", "nodeCount", "edgeCount", "expansionNodeCount", "expansionEdgeCount",
    "components", "preparedQueryBytes", "fullReloadBaselineBytes", "savedBytes", "reductionBasisPoints", "authority",
    "semanticIdentityEffect", "instructionAuthority", "promotionAuthority", "evidenceId", "evidenceHash",
  ], "Prepared traversal cost evidence");
  assertFields(document.protocol, ["name", "version"], "Prepared traversal cost protocol");
  assertFields(document.components, [
    "identityEnvelopeBytes", "graphManifestBytes", "boundedExpansionBytes", "graphSnapshotBytes", "fullTopologyRecordsBytes",
  ], "Prepared traversal cost components");
  const integers = [
    document.nodeCount, document.edgeCount, document.expansionNodeCount, document.expansionEdgeCount,
    ...Object.values(document.components), document.preparedQueryBytes, document.fullReloadBaselineBytes,
    document.savedBytes, document.reductionBasisPoints,
  ];
  if (document.schemaVersion !== 1 || document.kind !== "PreparedTraversalCostEvidence"
    || !format
    || document.protocol?.version !== PREPARED_TRAVERSAL_COST_VERSION
    || document.payloadModel !== "normalized-utf8-canonical-json-response-components"
    || typeof document.projectId !== "string" || !document.projectId
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(document.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(document.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(document.sourceSnapshotId || "")
    || !/^prepared-traversal-[a-f0-9]{24}$/.test(document.requestId || "")
    || !/^[a-f0-9]{64}$/.test(document.requestHash || "")
    || !/^traversal-query-[a-f0-9]{24}$/.test(document.queryId || "")
    || !/^[a-f0-9]{64}$/.test(document.queryHash || "")
    || !/^traversal-result-[a-f0-9]{24}$/.test(document.resultId || "")
    || !/^[a-f0-9]{64}$/.test(document.resultHash || "")
    || !/^[a-f0-9]{64}$/.test(document.expansionHash || "")
    || !/^[a-f0-9]{64}$/.test(document.graphManifestHash || "")
    || integers.some((value) => !Number.isSafeInteger(value) || value < 0)
    || document.reductionBasisPoints > 10000
    || document.preparedQueryBytes !== document.components.identityEnvelopeBytes
      + document.components.graphManifestBytes + document.components.boundedExpansionBytes
    || document.fullReloadBaselineBytes !== document.preparedQueryBytes
      + document.components.graphSnapshotBytes + document.components.fullTopologyRecordsBytes
    || document.savedBytes !== document.fullReloadBaselineBytes - document.preparedQueryBytes
    || document.reductionBasisPoints !== (document.fullReloadBaselineBytes === 0
      ? 0 : Math.floor((document.savedBytes * 10000) / document.fullReloadBaselineBytes))
    || document.authority !== "derived-performance-evidence-only" || document.semanticIdentityEffect !== "none"
    || document.instructionAuthority !== false || document.promotionAuthority !== false
    || !/^prepared-traversal-cost-[a-f0-9]{24}$/.test(document.evidenceId || "")
    || !/^[a-f0-9]{64}$/.test(document.evidenceHash || "")) {
    fail("Prepared traversal cost evidence is invalid.", "INVALID_PREPARED_TRAVERSAL_COST_EVIDENCE");
  }
  const payload = { ...document };
  delete payload.evidenceId;
  delete payload.evidenceHash;
  const evidenceHash = digest(graphProjectionCanonicalJson(payload));
  if (document.evidenceHash !== evidenceHash
    || document.evidenceId !== `prepared-traversal-cost-${evidenceHash.slice(0, 24)}`) {
    fail("Prepared traversal cost evidence digest verification failed.", "PREPARED_TRAVERSAL_COST_DIGEST_MISMATCH");
  }
  if (graph || request) {
    if (!graph || !request) fail("Graph and request must be supplied together.", "INVALID_PREPARED_TRAVERSAL_COST_EXPECTATION");
    const expected = buildPreparedTraversalCostEvidence({ graph, request, storage: format });
    if (graphProjectionCanonicalJson(document) !== graphProjectionCanonicalJson(expected)) {
      fail("Prepared traversal cost evidence differs from the deterministic expectation.", "PREPARED_TRAVERSAL_COST_EVIDENCE_MISMATCH");
    }
  }
  return document;
}
