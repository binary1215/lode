// Pure P4 reading helpers over one retained export. No IO or authority.
const explorerReadingModel = (() => {
  const digest = value => /^[a-f0-9]{64}$/.test(value || "");
  const key = value => JSON.stringify(value);
  const validPath = value => typeof value === "string" && value && !/[\\:\x00-\x1f\x7f]/.test(value) && !/^(?:\.head|\.lode|\.git)(?:\/|$)/i.test(value)
    && !/^[\\/]|^[A-Za-z]:/.test(value) && !value.split("/").some(part => part === "..");
  const basisFor = (snapshot, graph) => key([snapshot.project?.projectId || graph.basis?.projectId,
    graph === snapshot.graph ? "project" : "code", graph.basis || [graph.worldModelId, graph.semanticGraphId]]);
  function create(snapshot, graph) {
    const projectId = snapshot.project?.projectId || graph.basis?.projectId;
    const basis = basisFor(snapshot, graph);
    const nodes = new Map(graph.nodes.filter(node => !node.projectId || node.projectId === projectId).map(node => [node.nodeId, node]));
    const edges = new Map(), adjacency = new Map();
    const add = (id, edge) => { if (!adjacency.has(id)) adjacency.set(id, []); adjacency.get(id).push(edge); };
    for (const edge of graph.edges) {
      if (!edge.edgeId || edges.has(edge.edgeId) || edge.projectId && edge.projectId !== projectId) continue;
      edges.set(edge.edgeId, edge); add(edge.from, edge);
      if (edge.to !== edge.from) add(edge.to, edge);
    }
    const origin = value => value?.nodeId ? nodes.get(value.nodeId) : edges.get(value?.edgeId);
    function groups(value, eligible = () => true) {
      const exact = origin(value), list = exact?.nodeId ? adjacency.get(exact.nodeId) || [] : exact ? [exact] : [];
      const grouped = new Map();
      let filtered = 0, unknownEndpoints = 0, filteredKnown = 0;
      for (const edge of list) {
        const direction = !exact.nodeId ? "selected" : edge.from === edge.to ? "self" : edge.from === exact.nodeId ? "outgoing" : "incoming";
        const groupKey = key([basis, exact.nodeId || exact.edgeId, direction, edge.type || edge.relation]);
        if (!grouped.has(groupKey)) grouped.set(groupKey, { key: groupKey, direction, type: edge.type || edge.relation, edges: [], included: 0, filtered: 0 });
        const group = grouped.get(groupKey);
        group.included++;
        const missingEndpoint = !nodes.has(edge.from) || !nodes.has(edge.to);
        if (missingEndpoint) unknownEndpoints++;
        if (eligible(edge)) group.edges.push(edge);
        else { group.filtered++; filtered++; if (!missingEndpoint) filteredKnown++; }
      }
      return { groups: [...grouped.values()].sort((a, b) => a.direction.localeCompare(b.direction) || String(a.type).localeCompare(String(b.type))),
        included: list.length, filtered, filteredKnown, unknownEndpoints,
        omitted: graph.omittedEdgeCount ?? null, coverage: graph.coverage?.state || graph.status || "unknown" };
    }
    // A small target preview, grouped for display only. Parallel edge identities
    // remain in each row and in the complete paged relationship reader.
    function nextRead(value, eligible = () => true, limit = 4) {
      const exact = origin(value), grouped = groups(value, eligible), rows = [], byKey = new Map();
      const provenance = new Set(["SURFACE_FACT_FROM_OBSERVATION", "OBSERVES_EXACT_REVISION", "CURRENT_REVISION", "HAS_REVISION"]);
      // Provenance stays in the complete reader. Prefer actual navigation links
      // for this small preview; this is presentation, never evidence admission.
      const navigation = grouped.groups.filter(group => !provenance.has(group.type) && group.edges.some(edge => [edge.from, edge.to].some(id => id !== exact?.nodeId && nodes.has(id))));
      const ordered = navigation.length ? navigation : grouped.groups;
      for (const group of ordered) for (const edge of group.edges) {
        const targets = exact?.nodeId ? [edge.from === exact.nodeId ? edge.to : edge.from] : [...new Set([edge.from, edge.to])];
        for (const targetId of targets) {
          const node = nodes.get(targetId);
          if (!node || node.nodeId === exact?.nodeId) continue;
          const token = key([basis, group.direction, group.type, node.nodeId]);
          if (byKey.has(token)) { byKey.get(token).edges.push(edge); continue; }
          if (rows.length >= limit) continue;
          const row = { key: token, node, direction: group.direction, type: group.type, edges: [edge] };
          byKey.set(token, row); rows.push(row);
        }
      }
      return { rows, included: grouped.included, filtered: grouped.filtered, filteredKnown: grouped.filteredKnown, unknownEndpoints: grouped.unknownEndpoints };
    }
    function addresses(value) {
      const exact = origin(value);
      if (!exact || exact.projectId && exact.projectId !== projectId) return [];
      const references = [
        ["code", exact.executionSource],
        ["claim", exact.claimReference],
        ["source", validPath(exact.path) ? { path: exact.path, digest: exact.digest || exact.fileDigest, line: exact.line, endLine: exact.endLine } : null],
        ["source", exact.sourceReference],
        ...(Array.isArray(exact.referenceEvidence) ? exact.referenceEvidence.filter(ref => ref.kind === "source").map(ref => ["citation", ref]) : []),
      ];
      const found = new Map();
      for (const [role, ref] of references) {
        if (!ref || !validPath(ref.path) || !digest(ref.digest)) continue;
        const startLine = ref.startLine || ref.line, endLine = ref.endLine || startLine;
        const span = Number.isInteger(startLine) && startLine > 0 && Number.isInteger(endLine) && endLine >= startLine
          ? { startLine, endLine } : null;
        const address = { projectId, basis, nodeId: exact.nodeId || null, edgeId: exact.edgeId || null,
          role, path: ref.path, digest: ref.digest, span };
        address.key = key(address);
        // Distinct roles/revisions stay distinct, even when names or bytes match.
        found.set(address.key, address);
      }
      return [...found.values()];
    }
    function resolve(address) {
      if (!address || address.projectId !== projectId || address.basis !== basis) return null;
      const value = address.nodeId ? nodes.get(address.nodeId) : edges.get(address.edgeId);
      return addresses(value).find(candidate => candidate.key === address.key) || null;
    }
    function pairKey(file, pair) {
      return key([basis, file.path, pair.identity, pair.scope, pair.before, pair.after,
        pair.changeSet, pair.leftRecord, pair.rightRecord, pair.recordedReviewDecisionId, pair.recordedResultPacketId]);
    }
    const context = graph.contextLineage; // Never borrow comparisons across graph layers.
    function comparisons(address) {
      const exact = resolve(address);
      if (!exact) return [];
      const result = [];
      for (const file of context?.files || []) {
        if (file.path !== exact.path) continue;
        for (const pair of file.comparisons || []) for (const side of ["before", "after"]) {
          if (pair[side]?.path !== exact.path || pair[side]?.digest !== exact.digest) continue;
          result.push({ key: pairKey(file, pair), side, file, pair, address: exact });
        }
      }
      return result;
    }
    function read(address, choice = null) {
      const exact = resolve(address);
      if (!exact) return { status: "stale-or-unbound-address", chunks: [], choices: [] };
      const choices = comparisons(exact);
      let selected = null;
      if (choice) {
        const matching = choices.filter(item => item.key === choice.key && item.side === choice.side);
        if (matching.length !== 1) return { status: "ambiguous-or-unbound-pair", chunks: [], choices, address: exact };
        selected = matching[0];
      }
      const raw = snapshot.originals?.[key([exact.path, exact.digest])];
      if (!selected && raw?.status === "verified-exact-bytes" && raw.digest === exact.digest
        && raw.reference?.path === exact.path && raw.reference?.digest === exact.digest && typeof raw.text === "string") {
        const count = raw.text.split("\n").length;
        return { status: exact.span && exact.span.endLine > count ? "span-outside-source" : "available",
          address: exact, choices, chunks: [{ startLine: 1, text: raw.text, completeOriginal: true }], selected: null };
      }
      if (!selected && choices.length === 1) selected = choices[0];
      if (!selected) return { status: choices.length ? "choose-exact-comparison" : "source-not-included", address: exact, chunks: [], choices };
      const pair = selected.pair;
      const regions = pair.diff?.regions || (pair.diff?.before && pair.diff?.after ? [{ before: pair.diff.before, after: pair.diff.after }] : []);
      const chunks = regions.map(region => region[selected.side]).filter(region => Number.isInteger(region?.startLine) && typeof region.text === "string")
        .map(region => ({ ...region, completeOriginal: false }));
      if (!chunks.length && selected.side === "before" && pair.retainedOriginal?.digest === exact.digest) chunks.push({ ...pair.retainedOriginal, completeOriginal: false });
      const covered = exact.span && chunks.some(chunk => chunk.startLine <= exact.span.startLine
        && chunk.startLine + chunk.text.split("\n").length - 1 >= exact.span.endLine);
      return { status: !chunks.length ? "source-not-included" : chunks.some(chunk => chunk.textTruncated) ? "partial-source" : exact.span && !covered ? "span-not-included" : "available",
        address: exact, choices, chunks, selected };
    }
    return { basis, projectId, nodes, edges, origin, groups, nextRead, addresses, resolve, pairKey, comparisons, read };
  }
  return { create, basisFor };
})();
