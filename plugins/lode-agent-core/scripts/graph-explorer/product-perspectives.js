// Private display projection over already verified exported evidence. No writer or inferred cause.
const explorerProduct = (() => {
  const fields = { FeatureGroup: "featureGroups", Capability: "capabilities", Feature: "features", Requirement: "requirements", Constraint: "constraints", Decision: "decisions", Policy: "policies" };
  const type = edge => edge.type || edge.relation;
  const reference = node => ({ path: node?.path || node?.sourceReference?.path, digest: node?.digest || node?.fileDigest || node?.sourceReference?.digest });
  const refKey = ref => ref?.path && /^[a-f0-9]{64}$/.test(ref.digest || "") ? JSON.stringify([ref.path, ref.digest]) : null;
  function create(snapshot, graph) {
    const owner = snapshot.project?.projectId || graph.basis?.projectId, nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
    const links = new Map(), entities = new Map(), sourceCitations = new Map(), results = new Map(), workBuilders = new Map(), appliedTo = new Map();
    const edgeOrder = new Map(graph.edges.map((edge, i) => [edge, i]));
    const owned = node => Boolean(owner && node && (!node.projectId || node.projectId === owner) && node.integrity === "verified");
    const sameWorld = (a, b) => a?.origin?.layer === "world" && b?.origin?.layer === "world" && a.origin.worldModelId && a.origin.graphSnapshotId
      && (a.kind === "SourceSnapshot" ? a.nodeId : a.sourceSnapshotId)
      && a.origin.worldModelId === b.origin.worldModelId && a.origin.graphSnapshotId === b.origin.graphSnapshotId
      && (a.kind === "SourceSnapshot" ? a.nodeId : a.sourceSnapshotId) === (b.kind === "SourceSnapshot" ? b.nodeId : b.sourceSnapshotId);
    function identity(node) {
      if (!owned(node)) return null;
      const kind = node.kind?.replace(/Revision$/, ""); if (!fields[kind] || !node.key) return null;
      let model = node.productModelId;
      if (node.origin?.layer === "product" && node.origin.path && node.origin.digest) model ||= node.revisionId || node.sourceReference?.artifactId;
      else if (node.origin?.layer === "world") {
        const source = nodes.get(node.sourceSnapshotId);
        if (!owned(source) || source.kind !== "SourceSnapshot" || !sameWorld(node, source)) return null;
        model = source.productModelId;
      } else return null;
      return model ? { projectId: owner, model, kind, key: node.key, token: JSON.stringify([owner, model, kind, node.key]) } : null;
    }
    for (const node of graph.nodes) {
      const entity = identity(node); if (entity) { if (!entities.has(entity.token)) entities.set(entity.token, []); entities.get(entity.token).push(node);
        if (node.origin?.layer === "product") for (const target of node.appliesTo || []) {
          const token = JSON.stringify([owner, entity.model, target.kind, target.key]); if (!appliedTo.has(token)) appliedTo.set(token, []); appliedTo.get(token).push(node);
        }
      }
      if (owned(node) && node.origin?.layer === "sessionWork") for (const ref of node.referenceEvidence || []) {
        if (ref.kind !== "source") continue; const key = refKey(ref); if (!key) continue;
        if (!sourceCitations.has(key)) sourceCitations.set(key, []); sourceCitations.get(key).push({ node, reference: ref });
      }
    }
    for (const edge of graph.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      for (const id of new Set([edge.from, edge.to])) { if (!links.has(id)) links.set(id, []); links.get(id).push(edge); }
    }
    const neighbors = id => links.get(id) || [];
    const other = (edge, id) => nodes.get(edge.from === id ? edge.to : edge.from);
    function canonPairs(node) {
      const entity = identity(node); if (!entity || graph.contextLineage?.projectId && graph.contextLineage.projectId !== owner) return [];
      return (graph.contextLineage?.canonChanges || []).filter(pair => pair.review?.nodeId
        && [pair.before?.nodeId || pair.before?.productModelId, pair.after?.nodeId || pair.after?.productModelId].includes(entity.model))
        .map(pair => ({ pair, changes: (pair.changes || []).filter(change => change.field === fields[entity.kind] && change.key === entity.key) }));
    }
    function finishWork(view, includeWork) {
      if (includeWork && !view.workReady) { const reader = workBuilders.get(view.entity.token)(); let step; do { step = reader.next(); } while (!step.done); view.work = step.value; view.workReady = true; }
      return view;
    }
    function forFeature(node, { includeWork = true } = {}) {
      const entity = identity(node); if (!entity || !["Feature", "FeatureGroup", "Capability"].includes(entity.kind)) return null;
      if (results.has(entity.token)) return finishWork(results.get(entity.token), includeWork);
      const family = entities.get(entity.token);
      const structure = [], work = [], impact = [], sources = new Map(), workIds = new Set(), seen = new Set();
      const add = (list, target, edge, classification, via = [], sourceReference = null) => {
        if (!target) return; const key = JSON.stringify([list === structure ? "structure" : list === work ? "work" : "impact", edge ? edgeOrder.get(edge) : target.nodeId, classification, via.map(value => value.nodeId), sourceReference?.path, sourceReference?.digest]);
        if (seen.has(key)) return; seen.add(key); list.push({ node: target, edge, classification, via, sourceReference });
      };
      const addSource = target => { const ref = reference(target), key = refKey(ref); if (key && !sources.has(key)) sources.set(key, ref); };
      for (const member of family) for (const edge of neighbors(member.nodeId)) {
        const target = other(edge, member.nodeId), relation = type(edge);
        if (["CONTAINS", "REALIZES", "GOVERNED_BY", "HAS_REVISION", "CURRENT_REVISION"].includes(relation) && identity(target))
          add(structure, target, edge, "Recorded Product relationship");
        if (relation === "IMPLEMENTS" && edge.to === member.nodeId && /^(File|Symbol)(Revision)?$/.test(target.kind)
          && sameWorld(member, target) && edge.sourceSnapshotId === member.sourceSnapshotId
          && edge.provenance?.worldModelId === member.origin.worldModelId && edge.provenance?.graphSnapshotId === member.origin.graphSnapshotId && edge.authorityClass === "reviewed") {
          add(structure, target, edge, "Reviewed implementation mapping — not proof of execution"); addSource(target);
          for (const revisionEdge of neighbors(target.nodeId)) if (["HAS_REVISION", "CURRENT_REVISION"].includes(type(revisionEdge)) && revisionEdge.from === target.nodeId) {
            const revision = nodes.get(revisionEdge.to); if (sameWorld(target, revision)) {
              addSource(revision); add(structure, revision, revisionEdge, "Exact source revision of mapped code", [target]);
              if (revision.kind === "SymbolRevision" && revision.fileRevisionId) {
                const file = nodes.get(revision.fileRevisionId);
                if (file?.kind === "FileRevision" && sameWorld(revision, file) && file.path === revision.path) {
                  addSource(file); add(structure, file, null, "Exact declaring file revision — not a whole-file implementation claim", [revision]);
                }
              }
            }
          }
        }
        if (relation === "VERIFIED_BY" && edge.from === member.nodeId && /^(Test|TestRevision)$/.test(target.kind) && sameWorld(member, target) && edge.authorityClass === "reviewed" && edge.sourceSnapshotId === member.sourceSnapshotId
          && edge.provenance?.worldModelId === member.origin.worldModelId && edge.provenance?.graphSnapshotId === member.origin.graphSnapshotId) add(structure, target, edge, "Recorded test mapping — no pass verdict");
        if (target.origin?.layer === "sessionWork" && ["CITES_ARTIFACT", "CITES_WORK_EVIDENCE"].includes(relation)) {
          // A container citation never becomes a citation of every embedded Feature.
          add(work, target, edge, "Direct recorded citation — no fulfillment or cause"); workIds.add(target.nodeId);
        }
        if (["IMPACTS", "ADVANCES", "MEASURES", "AT_REVISION", "MOTIVATES"].includes(relation)) add(impact, target, edge, "Recorded related impact — no inferred outcome");
      }
      // Direct Canon membership is embedded, not invented graph edges. Bind every key to the exact model.
      for (const member of family.filter(value => value.origin?.layer === "product")) {
        for (const [field, kind] of [["featureGroupKeys", "FeatureGroup"], ["capabilityKeys", "Capability"]]) for (const key of member[field] || []) {
          for (const target of entities.get(JSON.stringify([owner, entity.model, kind, key])) || []) add(structure, target, null, "Exact Canon " + field, [member]);
        }
        for (const governed of member.governedBy || []) for (const target of entities.get(JSON.stringify([owner, entity.model, governed.kind, governed.key])) || []) add(structure, target, null, "Exact Canon governedBy", [member]);
      }
      for (const target of appliedTo.get(entity.token) || []) add(structure, target, null, "Exact Canon appliesTo", [node]);
      workBuilders.set(entity.token, function* () {
        const rows = [...work], seen = new Set(), ids = new Set(workIds); let examined = 0;
        const append = (target, edge, classification, via = [], sourceReference = null) => {
          const key = JSON.stringify([edge ? edgeOrder.get(edge) : target.nodeId, classification, sourceReference?.path, sourceReference?.digest]);
          if (seen.has(key)) return; seen.add(key); rows.push({ node: target, edge, classification, via, sourceReference });
        };
        yield; // Paint the requested perspective before any potentially large traversal.
        for (const [key] of sources) for (const citation of sourceCitations.get(key) || []) {
          append(citation.node, null, "Related via exact mapped-source citation — not implementation cause", family.slice(0, 1), citation.reference); ids.add(citation.node.nodeId);
          if (++examined % 512 === 0) yield;
        }
        const queue = [...ids]; for (let i = 0; i < queue.length; i++) for (const edge of neighbors(queue[i])) {
          if (++examined % 512 === 0) yield;
          if (!["DECLARES_WORK_ROOT", "FOLLOWS_WORK_EVIDENCE", "CITES_WORK_EVIDENCE", "SAVED_OBSERVATION_OF"].includes(type(edge))) continue;
          const target = other(edge, queue[i]); if (!owned(target) || target.origin?.layer !== "sessionWork") continue;
          append(target, edge, "Explicit recorded work lineage — historical, not a current Todo");
          if (!ids.has(target.nodeId)) { ids.add(target.nodeId); queue.push(target.nodeId); }
        }
        return rows;
      });
      const pairs = canonPairs(node);
      const result = { entity, structure, work: [], workReady: false, impact, sourceBindings: [...sources.values()], canonPairs: pairs,
        coverage: "Only exported verified relationships and exact citations; missing detail is not proof of absence." };
      results.set(entity.token, result); return finishWork(result, includeWork);
    }
    function fileMatches(node, file, pair = null) {
      const view = forFeature(node, { includeWork: false }); if (!view) return false;
      const digests = pair ? [pair.before?.digest, pair.after?.digest, pair.citedReference?.digest, pair.gap?.expectedDigest, ...(pair.gaps || []).map(gap => gap.expectedDigest)]
        : [file.current?.digest, ...(file.comparisons || []).flatMap(pair => [pair.before?.digest, pair.after?.digest, pair.citedReference?.digest])];
      return view.sourceBindings.some(ref => ref.path === file.path && digests.includes(ref.digest));
    }
    async function prepareWork(node, { cancelled = () => false, yieldWork = () => Promise.resolve() } = {}) {
      const view = forFeature(node, { includeWork: false }); if (!view || view.workReady) return view;
      const reader = workBuilders.get(view.entity.token)();
      for (;;) {
        if (cancelled()) return null;
        const step = reader.next();
        if (step.done) { if (cancelled()) return null; view.work = step.value; view.workReady = true; return view; }
        await yieldWork();
      }
    }
    return { identity, forFeature, prepareWork, canonPairs, fileMatches };
  }
  return { create };
})();
