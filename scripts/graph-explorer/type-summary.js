// Counts of actual exported kinds/types. Grouping creates no semantic nodes.
const explorerTypeSummary = (() => {
  async function count(graph, { includeNode = () => true, includeEdge = () => true,
    cancelled = () => false, yieldWork = () => Promise.resolve() } = {}) {
    const kinds = new Map(), types = new Map(), nodes = new Set(), eligible = new Set(), edges = new Set();
    let examinedNodes = 0, examinedEdges = 0, missingEndpoints = 0, filteredEdges = 0;
    const result = complete => ({ complete, examinedNodes, examinedEdges, includedNodes: eligible.size,
      exportedNodes: nodes.size, exportedEdges: edges.size, eligibleEdges: edges.size - filteredEdges - missingEndpoints,
      filteredEdges, missingEndpointEdges: missingEndpoints, omittedEdges: graph.omittedEdgeCount ?? null,
      coverage: graph.coverage?.state || graph.status || "unknown",
      kinds: [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
      types: [...types.values()].sort((a, b) => a.type.localeCompare(b.type)) });
    await yieldWork();
    for (const node of graph.nodes) {
      if (cancelled()) return result(false);
      if (!nodes.has(node.nodeId)) {
        nodes.add(node.nodeId);
        const kind = node.kind || "Unknown";
        if (!kinds.has(kind)) kinds.set(kind, { kind, included: 0, exported: 0 });
        const row = kinds.get(kind); row.exported++;
        if (includeNode(node)) { eligible.add(node.nodeId); row.included++; }
      }
      if (++examinedNodes % 256 === 0) await yieldWork();
    }
    for (const edge of graph.edges) {
      if (cancelled()) return result(false);
      if (!edges.has(edge.edgeId)) {
        edges.add(edge.edgeId);
        const type = edge.type || edge.relation || "Unknown";
        if (!types.has(type)) types.set(type, { type, included: 0, exported: 0, missing: 0 });
        const row = types.get(type); row.exported++;
        if (!nodes.has(edge.from) || !nodes.has(edge.to)) { row.missing++; missingEndpoints++; }
        else if (eligible.has(edge.from) && eligible.has(edge.to) && includeEdge(edge)) row.included++;
        else filteredEdges++;
      }
      if (++examinedEdges % 256 === 0) await yieldWork();
    }
    return result(!cancelled());
  }
  return { count };
})();
