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
function relationEdgeBody(edge) {
  const body = { ...edge };
  for (const key of ["edgeId", "sourceSnapshotId", "contentRevisionId", "logicalRelationId"]) delete body[key];
  return body;
}
export function stabilizeTemporalRelationIdentities(graph, { relationAnalysisBasis = null, reusedEdges = null } = {}) {
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const reusable = new Map();
  const sameBasis =
    reusedEdges && JSON.stringify(canonical(reusedEdges.relationAnalysisBasis ?? null)) === JSON.stringify(canonical(relationAnalysisBasis ?? null));
  if (sameBasis) {
    for (const edge of reusedEdges.edges || []) reusable.set(`${edge.type}\0${edge.from}\0${edge.to}`, edge);
  }
  const edges = graph.edges
    .map((original) => {
      const edge = { ...original, producerVersion: RELATION_IDENTITY_VERSION };
      const previous = reusable.get(`${edge.type}\0${edge.from}\0${edge.to}`);
      // Unchanged endpoints and relation body keep their ids. Only a changed
      // record, or an edge that touches one, is hashed again.
      if (previous && JSON.stringify(canonical(relationEdgeBody(previous))) === JSON.stringify(canonical(relationEdgeBody(edge)))) {
        return {
          ...edge,
          logicalRelationId: previous.logicalRelationId,
          contentRevisionId: previous.contentRevisionId,
          edgeId: previous.edgeId,
        };
      }
      return { ...edge, ...temporalRelationIdentity(edge, { ...graph, nodes, relationAnalysisBasis }) };
    })
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const payload = { ...graph, protocol: { ...graph.protocol, version: RELATION_IDENTITY_VERSION }, relationAnalysisBasis, edges };
  delete payload.graphSnapshotId;
  delete payload.graphSnapshotHash;
  const graphSnapshotHash = hash(payload);
  return { ...payload, graphSnapshotId: "graph-snapshot-" + graphSnapshotHash.slice(0, 24), graphSnapshotHash };
}
