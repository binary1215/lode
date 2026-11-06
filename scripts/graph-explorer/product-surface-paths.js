// Inline, read-only directional navigation over exported exact evidence.
const explorerSurfacePaths = (() => {
  const surfaceKinds = new Set(["UserActivity", "ProductSurface", "SurfaceElement",
    "ExecutionEntrypoint", "DataResource", "ExternalConnection"]);
  const forward = new Set(["ACTIVITY_USES_ELEMENT", "SURFACE_CONTAINS_ELEMENT", "ELEMENT_INVOKES_ENTRYPOINT",
    "ENTRYPOINT_RETURNS_ELEMENT", "ACTIVITY_NEXT", "HANDLED_BY_EXACT_SOURCE", "CITES_EXECUTION_SOURCE",
    "CALLS", "IMPORTS", "READS_DATA", "WRITES_DATA", "CALLS_EXTERNAL", "COMPARES_RECORDED_OUTPUT"]);
  const reverse = new Set(["SURFACE_CONTAINS_ELEMENT", "ACTIVITY_USES_ELEMENT", "ELEMENT_INVOKES_ENTRYPOINT",
    "ENTRYPOINT_RETURNS_ELEMENT", "HANDLED_BY_EXACT_SOURCE", "CITES_EXECUTION_SOURCE", "CALLS", "IMPORTS",
    "READS_DATA", "WRITES_DATA", "CALLS_EXTERNAL"]);

  function create(snapshot, graph) {
    const owner = snapshot.project?.projectId || graph.basis?.projectId;
    const nodes = new Map(graph.nodes.filter(node => !node.projectId || node.projectId === owner).map(node => [node.nodeId, node]));
    const outgoing = new Map(), incoming = new Map(), sourceWrappers = new Map();
    const containedElements = new Map(), entrypointOutputs = new Map();
    const add = (map, key, edge) => { if (!map.has(key)) map.set(key, []); map.get(key).push(edge); };
    for (const node of nodes.values()) if (node.structuralNodeId) {
      const key = JSON.stringify([node.origin?.worldModelId, node.origin?.semanticGraphId, node.structuralNodeId]);
      if (!sourceWrappers.has(key)) sourceWrappers.set(key, []);
      sourceWrappers.get(key).push(node);
    }
    for (const edge of graph.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      if (forward.has(edge.type)) add(outgoing, edge.from, edge);
      if (reverse.has(edge.type)) add(incoming, edge.to, edge);
      if (edge.type === "SURFACE_CONTAINS_ELEMENT") add(containedElements, edge.from, edge);
      if (edge.type === "ENTRYPOINT_RETURNS_ELEMENT") add(entrypointOutputs, edge.from, edge);
    }
    const reverseEntrypoints = new Map([...entrypointOutputs].map(([nodeId, outputs]) =>
      [nodeId, [...(incoming.get(nodeId) || []), ...outputs]]));
    const eligible = (node, history) => history || !(node.currentTraversalEligible === false
      || node.snapshotState === "historical" || /^(historical|domain-not-current|unavailable)/.test(node.freshness || ""));
    function resolve(node) {
      if ((surfaceKinds.has(node?.kind) || ["surface-code", "product-surface-source"].includes(node?.origin?.layer))
        && nodes.has(node.nodeId)) return nodes.get(node.nodeId);
      if (["FileRevision", "SymbolRevision"].includes(node?.kind)) {
        const digest = node.digest || nodes.get(node.fileRevisionId)?.digest;
        const candidates = [...nodes.values()].filter(candidate => candidate.origin?.layer === "surface-code"
          && candidate.path === node.path && candidate.digest === digest
          && (node.kind === "FileRevision" ? candidate.kind === "FileRevisionReference"
            : candidate.kind === "SymbolRevisionReference" && candidate.name === node.name && candidate.line === node.line));
        if (candidates.length === 1) return candidates[0];
      }
      const matches = sourceWrappers.get(JSON.stringify([
        snapshot.codeGraph?.worldModelId, snapshot.codeGraph?.semanticGraphId, node?.nodeId,
      ])) || [];
      return matches.length === 1 ? matches[0] : null;
    }
    function supports(node) {
      const exact = resolve(node);
      return Boolean(exact && (surfaceKinds.has(exact.kind)
        || exact.origin?.layer === "surface-code" || exact.origin?.layer === "product-surface-source"));
    }
    function begin(node, direction = "forward", includeHistory = false) {
      const root = resolve(node);
      if (!root || !["forward", "reverse"].includes(direction)) return null;
      return { root, direction, includeHistory, queue: [{ node: root, depth: 0 }], at: 0, edgeAt: 0,
        seenNodes: new Set([root.nodeId]), seenEdges: new Set(), complete: false, excluded: 0, examined: 0 };
    }
    function step(state, maxWork = 128) {
      const rows = [];
      let work = 0;
      while (!state.complete && work < maxWork) {
        if (state.at >= state.queue.length) { state.complete = true; break; }
        const current = state.queue[state.at];
        let links = (state.direction === "forward" ? outgoing : incoming).get(current.node.nodeId) || [];
        // An entrypoint's declared outputs and an output container's elements
        // stay typed links, not inverse execution or inferred common purpose.
        if (state.direction === "reverse" && current.node.kind === "ExecutionEntrypoint") {
          links = reverseEntrypoints.get(current.node.nodeId) || links;
        }
        if (state.direction === "reverse" && state.at === 0 && current.node.kind === "ProductSurface") {
          links = containedElements.get(current.node.nodeId) || [];
        }
        if (state.edgeAt >= links.length) { state.at++; state.edgeAt = 0; work++; continue; }
        const edge = links[state.edgeAt++];
        state.examined++; work++;
        if (state.seenEdges.has(edge.edgeId)) continue;
        state.seenEdges.add(edge.edgeId);
        const id = edge.from === current.node.nodeId ? edge.to : edge.from, target = nodes.get(id);
        if (!eligible(target, state.includeHistory) || edge.currentTraversalEligible === false && !state.includeHistory) {
          state.excluded++; continue;
        }
        const cycle = state.seenNodes.has(id), via = [current.node.nodeId], depth = current.depth + 1;
        rows.push({ node: target, edge, via, depth, cycle,
          classification: edge.type === "CALLS" || edge.type === "IMPORTS"
            ? "Static source relation; execution not proven" : "Explicit recorded relation claim" });
        if (!cycle) { state.seenNodes.add(id); state.queue.push({ node: target, depth }); }
      }
      return { rows, complete: state.complete, examined: state.examined,
        visited: state.seenNodes.size, excluded: state.excluded };
    }
    async function next(state, { maxWork = 512, cancelled = () => false, yieldWork = () => Promise.resolve() } = {}) {
      const rows = [];
      await yieldWork();
      let total = 0, result;
      while (!state.complete && total < maxWork) {
        if (cancelled()) return { rows: [], cancelled: true, complete: false };
        result = step(state, Math.min(64, maxWork - total));
        rows.push(...result.rows); total += 64;
        await yieldWork();
      }
      if (cancelled()) return { rows: [], cancelled: true, complete: false };
      return { ...result, rows, complete: state.complete, cancelled: false };
    }
    async function relatedWork(state, { cancelled = () => false, yieldWork = () => Promise.resolve() } = {}) {
      const refs = new Set([...state.seenNodes].map(id => nodes.get(id))
        .flatMap(node => [node.path && node.digest ? { path: node.path, digest: node.digest } : null, node.executionSource])
        .filter(Boolean).map(ref => JSON.stringify([ref.path, ref.digest])));
      const rows = [];
      let work = 0;
      for (const node of nodes.values()) {
        if (cancelled()) return null;
        if (node.origin?.layer === "sessionWork") for (const ref of node.referenceEvidence || []) {
          if (ref.kind !== "source" || !refs.has(JSON.stringify([ref.path, ref.digest]))) continue;
          rows.push({ node, edge: null, via: [],
            classification: ["matching-current-bytes", "intact-retained-original"].includes(ref.status)
              ? "Work cites matching current / retained source bytes; related evidence, not cause or fulfillment"
              : "Work cites the same exact source reference; byte availability remains " + (ref.status || "unknown")
                + "; not cause or fulfillment" });
          break;
        }
        if (++work % 128 === 0) await yieldWork();
      }
      return rows;
    }
    return { supports, resolve, begin, step, next, relatedWork, surfaceKinds };
  }
  return { create };
})();
