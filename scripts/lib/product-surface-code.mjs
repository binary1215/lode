import { observationDigest } from "./observation-contract.mjs";

// Thin P4 wrappers preserve the original structural namespace and provenance.
// A source path or display name never merges structural and temporal entities.
export function projectSurfaceCodeReferences({ projectId, world, includeNonCurrent = false }) {
  const graph = world?.snapshot?.semanticGraph;
  if (!graph) return { nodes: [], edges: [], sources: [], coverage: { state: "structural-unavailable" } };
  const worldId = world.snapshot.worldModelId, semanticGraphId = graph.semanticGraphId;
  const current = world.historical || world.freshness.domains.code.status === "current";
  const ids = new Map(graph.nodes.map(node => [node.id, "surface-code-" + observationDigest({
    projectId, worldId, semanticGraphId, sourceNodeId: node.id,
  }).slice(0, 24)]));
  const authority = { instructionAuthority: false, promotionAuthority: false,
    recoveryAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false };
  const origin = { layer: "surface-code", worldModelId: worldId, semanticGraphId,
    graphSnapshotId: world.snapshot.temporalProvenanceGraph.graphSnapshotId };
  const nodes = graph.nodes.map(node => ({
    nodeId: ids.get(node.id),
    kind: node.kind === "File" ? "FileRevisionReference"
      : node.kind === "Symbol" ? "SymbolRevisionReference" : "ExternalDependency",
    name: node.name || node.specifier || node.path, qualifiedName: node.qualifiedName,
    path: node.path, digest: node.fileDigest || node.digest,
    line: node.line, endLine: node.endLine, symbolKind: node.symbolKind,
    projectId, revisionId: semanticGraphId, structuralNodeId: node.id,
    identityAmbiguous: node.identityAmbiguous || false,
    sourceReference: node.path && (node.fileDigest || node.digest) ? {
      path: node.path, digest: node.fileDigest || node.digest, startLine: node.line, endLine: node.endLine,
    } : null,
    origin, views: ["product", "work"], integrity: "verified", reviewState: "parsed-structural-evidence",
    freshness: world.historical ? "historical" : current ? "snapshot-evidence" : "domain-not-current",
    currentTraversalEligible: current, snapshotState: world.historical ? "historical" : "pointer-snapshot",
    ...authority,
  }));
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)
    && (current || includeNonCurrent)).map(edge => ({
    edgeId: "surface-code-edge-" + observationDigest({ projectId, worldId, semanticGraphId, sourceEdgeId: edge.id }).slice(0, 24),
    type: edge.type, from: ids.get(edge.from), to: ids.get(edge.to), structuralEdgeId: edge.id,
    provenance: { ...origin, sourceEdgeId: edge.id, parserProtocol: graph.protocol, evidence: edge.evidence },
    referenceEvidence: edge.evidence, currentTraversalEligible: current,
    interpretation: "Static structural evidence, not runtime execution or product cause.", ...authority,
  }));
  const sources = nodes.filter(node => node.path && node.digest)
    .map(node => ({ path: node.path, digest: node.digest, nodeId: node.nodeId, origin }));
  return { nodes, edges, sources, coverage: {
    state: current ? world.historical ? "historical-structural" : "verified-structural" : "non-current-structural",
    worldModelId: worldId, semanticGraphId, nodeCount: nodes.length, edgeCount: edges.length,
    sourceProtocol: graph.protocol, accuracy: graph.accuracy, runtimeVerified: false,
  } };
}
