import { sha256Hex } from "../core/digest.mjs";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const ordered = {};
  // Preserve exactly the old sorted own-key JSON, without allocating a pair
  // array and intermediate entries array for every visited object.
  for (const key of Object.keys(value).sort()) {
    const child = canonical(value[key]);
    if (key === "__proto__") Object.defineProperty(ordered, key, { value: child, enumerable: true, writable: true, configurable: true });
    else ordered[key] = child;
  }
  return ordered;
}
const hash = (value) => sha256Hex(JSON.stringify(canonical(value)));
export const RELATION_IDENTITY_VERSION = "0.16.0";
// Logical relation identity includes endpoint continuity. Content revision keeps
// evidence/authority/confidence/producer differences; global membership is an
// observation only. Edges TO a snapshot still bind that exact endpoint.
export function temporalRelationIdentity(edge, { projectId, nodes, logicalLineageState = {}, relationAnalysisBasis = null }) {
  const endpoint = (id) => {
    const node = nodes.get(id),
      logicalEntityId = node?.logicalEntityId || id;
    return {
      kind: node?.kind?.replace(/Revision$/, "") || null,
      logicalEntityId,
      generation: logicalLineageState.continuityGenerationByLogicalEntityId?.[logicalEntityId] || 0,
      continuityUnknown: (logicalLineageState.continuityUnknownLogicalEntityIds || []).includes(logicalEntityId),
    };
  };
  const logical = {
    projectId,
    relationAnalysisBasis,
    type: edge.type,
    from: endpoint(edge.from),
    to: endpoint(edge.to),
    authorityClass: edge.authorityClass,
    origin: edge.origin,
    producer: edge.producer,
    producerVersion: edge.producerVersion,
  };
  const logicalRelationId = "relation-" + hash(logical).slice(0, 24);
  const content = { ...edge, logicalRelationId };
  for (const key of ["edgeId", "sourceSnapshotId", "contentRevisionId"]) delete content[key];
  const revision = hash({ projectId, content });
  return { logicalRelationId, contentRevisionId: "relation-revision-" + revision.slice(0, 24), edgeId: "temporal-edge-" + revision.slice(0, 24) };
}
export function stabilizeTemporalRelationIdentities(graph, { relationAnalysisBasis = null } = {}) {
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const edges = graph.edges
    .map((original) => {
      const edge = { ...original, producerVersion: RELATION_IDENTITY_VERSION };
      return { ...edge, ...temporalRelationIdentity(edge, { ...graph, nodes, relationAnalysisBasis }) };
    })
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const payload = { ...graph, protocol: { ...graph.protocol, version: RELATION_IDENTITY_VERSION }, relationAnalysisBasis, edges };
  delete payload.graphSnapshotId;
  delete payload.graphSnapshotHash;
  const graphSnapshotHash = hash(payload);
  return { ...payload, graphSnapshotId: "graph-snapshot-" + graphSnapshotHash.slice(0, 24), graphSnapshotHash };
}
