// Private, inline-only display helpers. Never a writer, semantic classifier or authority.
const explorerCards = (() => {
  const string = value => typeof value === "string" ? value : "";
  const first = (...values) => values.find(value => typeof value === "string" && value.trim()) || "";
  const label = (values, key, fallback) => typeof key === "string" && Object.hasOwn(values, key) ? values[key] : fallback;
  const historical = value => value.currentTraversalEligible === false || value.snapshotState === "historical" || value.historical === true
    || /^(?:historical|domain-not-current|unavailable)/.test(value.freshness || "");
  const kindName = value => value?.origin?.layer === "sessionWork" ? "Agent-authored work record"
    : label({ ProjectDirection: "Recorded project direction", FileRevision: "Source file revision", SymbolRevision: "Source symbol revision",
      File: "Source file", Symbol: "Source declaration", HeadSessionStateReference: "Logical Session record", LodeSessionStateReference: "Logical Session record",
      Run: "Recorded execution Run", ResultPacket: "Recorded result", ReviewDecision: "Recorded review", ChangeSet: "Recorded source changes",
      FeatureGroup: "Product feature group", Feature: "Product feature", Requirement: "Product requirement", Constraint: "Product constraint",
      UserActivity:"User activity", ProductSurface:"Screen / output", SurfaceElement:"Screen element", ExecutionEntrypoint:"Entrypoint", DataResource:"Data contact", ExternalConnection:"External contact", SymbolRevisionReference:"Referenced symbol version",
      Evidence:"Recorded evidence", FileRevisionReference:"Referenced file version", LodeSession:"Work session", SourceSnapshot:"Source version", ObservationCollectionReceipt:"Collection record", ObservationRecord:"Observation", ObservationTypeDescriptor:"Observation type",
      Repository:"Repository", ProductModelRevision: "Product definition version" }, value?.kind, string(value?.kind) || "Recorded relationship");
  const title = value => first(value?.name, value?.title, value?.qualifiedName, value?.objective, value?.purpose,
    value?.semantic?.name, value?.semantic?.statement, value?.directionEvidence?.goal, value?.workContent?.summary, value?.workContent?.todos?.[0]?.task, value?.summary, value?.proposedPolicy?.name,
    value?.planDelta, value?.outcome, sourcePath(value?.path), value?.statement, value?.assessment, value?.rationale)
    || (value?.kind === "ChangeSet" ? "Recorded source changes" : `Unnamed ${kindName(value).toLocaleLowerCase()}`);
  // Typed presentation only. Never scrub authored text or change binding identity.
  const statusLabels = {
    "unknown-boundary": "Source range uncertain", "unmatched-declaration-not-proven-rename-or-continuity": "No matching declaration",
    "comment-text-only-difference": "Only comment text differs", "trailing-layout-only-difference": "Trailing whitespace differs",
    "declaration-bytes-changed": "Source changed", "declaration-bytes-unchanged": "Source unchanged",
    "retained-evidence": "Retained record", "pointer-snapshot": "Recorded snapshot",
    authored: "Recorded description", declared: "Declared connection", inferred: "Inferred description", "runtime-recorded": "Recorded execution", unknown: "Uncertain",
    "non-canonical-source-claim": "Source description", unreviewed: "Not reviewed", pending: "Pending", proposed: "Proposed", accepted: "Review accepted", rejected: "Review rejected",
    cancelled: "Cancelled", canceled: "Cancelled", failed: "Failed", succeeded: "Succeeded", completed: "Completed", paused: "Paused", running: "Running",
    "exact-current-source-bytes": "Source matches", "historical-or-unavailable-source": "Current source not confirmed", "cited-range-differs-from-claim": "Quoted text differs",
    unavailable: "Source unavailable", "not-inspected": "Source not checked", "file-reference-only": "Symbol not confirmed", "exact-symbol-in-retained-world": "Linked symbol",
    "historical-source-bytes": "Earlier source version", "domain-not-current": "Outdated source", historical: "Historical", "intact-historical-work-evidence": "Recorded work",
    "source-not-included": "Source text not included", "span-not-included": "Requested lines not included", "span-outside-source": "Requested lines are outside the source",
    "partial-source": "Partial source text", "choose-exact-comparison": "Choose a source version", "stale-or-unbound-address": "Source reference unavailable",
    "ambiguous-or-unbound-pair": "Comparison reference unavailable", "verified-exact-bytes": "Source text included",
  };
  const ordinary = new Set(["available", "current", "snapshot-evidence", "current-canon-bytes", "current-source-bytes", "not-applicable", "observed", "observed-evidence", "parsed-structural-evidence"]);
  const statusLabel = state => ordinary.has(state) ? "" : label(statusLabels, state, state ? "Unrecognized recorded state" : "");
  const sourcePath = value => /^(?:\.lode|\.head|\.git)(?:[\\/]|$)/i.test(string(value)) ? "" : string(value);
  const kindLabel = kind => kindName({ kind });
  const relationLabel = type => label({
    CALLS: "Calls", IMPORTS: "Imports", ACTIVITY_NEXT: "Next recorded activity", ACTIVITY_USES_ELEMENT: "Uses element", SURFACE_CONTAINS_ELEMENT: "Contains element",
    ELEMENT_INVOKES_ENTRYPOINT: "Links to entrypoint", ENTRYPOINT_RETURNS_ELEMENT: "Returns output", CITES_EXECUTION_SOURCE: "References implementation",
    OBSERVES_EXACT_REVISION: "References source version", SURFACE_FACT_FROM_OBSERVATION: "Recorded in observation", CITES_EXACT_REVISION: "Cites source version",
    CITES_WORK_EVIDENCE: "Cites work record", CITES_ARTIFACT: "Cites document", DECLARES_WORK_ROOT: "Work starting point", FOLLOWS_WORK_EVIDENCE: "Follows work record",
    RECORDED_RESULT: "Recorded result", RECORDED_REVIEW: "Recorded review", OBSERVES_BEFORE_REVISION: "Before change", OBSERVES_AFTER_REVISION: "After change",
    REFERS_TO_PREVIOUS_CANON: "Previous product definition", REFERS_TO_BASE_CANON: "Base product definition", REFERS_TO_RESULT_CANON: "Resulting product definition",
    CONFORMS_TO: "Conforms to", CONTAINS: "Contains", CURRENT_REVISION: "Current version", DECLARES: "Declares", HAS_REVISION: "Has version", IDENTIFIES_SESSION: "Session record",
    EVIDENCED_BY: "Supported by", RECORDED_FOR_SESSION: "Recorded for session", IMPLEMENTS: "Implements", VERIFIED_BY: "Verified by",
  }, type, string(type) || "Relationship");
  const comparisonSide = (pair, side) => pair.scope === "recorded-changeset-snapshot-pair" ? side === "before" ? "Before change" : "After change"
    : pair.scope === "explicit-work-chain-citation-pair-not-request-boundary" ? side === "before" ? "Cited version A" : "Cited version B"
      : pair.scope === "cited-revision-versus-observed-current-bytes" ? side === "before" ? "Recorded source" : "Current at export"
        : side === "before" ? "Version A" : "Version B";
  const factText = value => typeof value === "string" ? value : first(value?.task, value?.assessment, value?.summary, value?.title, value?.name, value?.description, value?.reason) || "Additional recorded detail";
  const technicalFields = value => Object.fromEntries([
    "nodeId", "edgeId", "projectId", "sessionId", "revisionId", "fileRevisionId", "sourceSnapshotId", "worldModelId", "graphSnapshotId", "semanticGraphId", "productModelId",
    "kind", "type", "key", "digest", "fileDigest", "evidenceDigest", "basis", "producer", "schema", "schemaVersion", "analysisVersion", "status", "state", "reviewState", "claimBasis",
    "freshness", "sourceCurrentness", "viewerCurrentness", "snapshotState", "currentTraversalEligible", "sourceReference", "provenance", "origin", "referenceEvidence", "executionSource", "claimReference", "claimEvidence", "executionBinding", "executionEvidence",
    "path", "reasonCode", "detailReasonCode", "detailCoverage", "contentCoverage", "workContentCoverage", "directionContentCoverage", "workContentExcerpts",
  ].filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const humanTitle = value => {
    // Authored names remain verbatim, even when they happen to equal an ID.
    // The renderer itself never synthesizes a title from an identifier.
    const name = value?.name;
    return first(name, value?.title, value?.qualifiedName, value?.semantic?.name, value?.semantic?.statement)
      || title({ ...value, name: "", nodeId: "", edgeId: "" });
  };
  function create(snapshot, graph, layer) {
    const owner = snapshot.project?.projectId || graph.basis?.projectId || null;
    const nodes = new Map(graph.nodes.map(node => [node.nodeId, node])), groups = new Map(), memberships = new Map(), descriptions = new WeakMap();
    const owned = node => Boolean(owner && node && (!node.projectId || node.projectId === owner) && node.integrity === "verified");
    const originKey = origin => [origin?.layer, origin?.path, origin?.digest, origin?.worldModelId, origin?.graphSnapshotId];
    function frame(node) {
      if (!owned(node)) return null;
      const origin = node.origin;
      if (origin?.layer === "world") return origin.worldModelId && origin.graphSnapshotId && node.sourceSnapshotId
        ? JSON.stringify([owner, ...originKey(origin), node.sourceSnapshotId]) : null;
      const revision = node.productModelId || node.revisionId || node.sourceReference?.artifactId;
      return origin?.layer === "product" && origin.path && origin.digest && revision ? JSON.stringify([owner, ...originKey(origin), revision]) : null;
    }
    function membership(type, root, member, basis) {
      if (root.nodeId === member.nodeId) return;
      const key = JSON.stringify([type, basis, root.nodeId]);
      if (!groups.has(key)) groups.set(key, { key, type, rootId: root.nodeId, title: title(root), members: new Set([root.nodeId]), basis, order: groups.size });
      const group = groups.get(key); group.members.add(member.nodeId);
      for (const id of [root.nodeId, member.nodeId]) { if (!memberships.has(id)) memberships.set(id, new Set()); memberships.get(id).add(key); }
    }
    const revisionSemantics = new Map();
    for (const edge of graph.edges) if ((edge.type || edge.relation) === "CURRENT_REVISION") {
      const node = nodes.get(edge.from), revision = nodes.get(edge.to);
      if (owned(node) && owned(revision) && revision.logicalEntityId === node.nodeId && revision.semantic
        && node.origin?.layer === "world" && revision.origin?.layer === "world"
        && node.origin.worldModelId && node.origin.graphSnapshotId && node.sourceSnapshotId
        && node.origin.worldModelId === revision.origin.worldModelId && node.origin.graphSnapshotId === revision.origin.graphSnapshotId
        && node.sourceSnapshotId === revision.sourceSnapshotId && !revisionSemantics.has(node)) revisionSemantics.set(node, revision.semantic);
    }
    const featureGroups = new Map();
    for (const node of graph.nodes) if (node.kind === "FeatureGroup" && frame(node) && node.key) featureGroups.set(JSON.stringify([frame(node), node.key]), node);
    for (const node of graph.nodes) {
      if (!["Feature", "FeatureGroup"].includes(node.kind) || node.origin?.layer === "world") continue;
      const basis = frame(node); if (!basis) continue;
      const keys = node.kind === "Feature" ? node.featureGroupKeys : node.parentFeatureGroupKeys;
      for (const key of Array.isArray(keys) ? keys : []) {
        const group = featureGroups.get(JSON.stringify([basis, key]));
        if (group) membership("Recorded FeatureGroup membership", group, node, basis);
      }
    }
    for (const edge of graph.edges) {
      const from = nodes.get(edge.from), to = nodes.get(edge.to), type = edge.type || edge.relation;
      if (!owned(from) || !owned(to)) continue;
      if (type === "DECLARES_WORK_ROOT" && from.origin?.layer === "sessionWork" && to.origin?.layer === "sessionWork"
        && from.origin.path && from.origin.digest && to.origin.path && to.origin.digest
        && from.sessionId && from.sessionId === to.sessionId && edge.provenance?.layer === "sessionWork"
        && edge.provenance.path === from.origin.path && edge.provenance.digest === from.origin.digest) {
        membership("Declared work group", to, from, JSON.stringify([owner, layer, to.nodeId, to.origin.digest, to.sessionId]));
      }
      if (type === "CONTAINS" && from.kind === "FeatureGroup" && ["FeatureGroup", "Feature"].includes(to.kind)
        && from.origin?.layer === "world" && frame(from) && frame(from) === frame(to)
        && edge.sourceSnapshotId === from.sourceSnapshotId && edge.provenance?.worldModelId === from.origin.worldModelId
        && edge.provenance?.graphSnapshotId === from.origin.graphSnapshotId) membership("Snapshot FeatureGroup membership", from, to, frame(from));
    }
    function describe(value) {
      if (descriptions.has(value)) return descriptions.get(value);
      const work = value.workContent, semantic = value.semantic || revisionSemantics.get(value);
      const body = first(work?.summary, value.directionEvidence?.goal, value.description, value.summary,
        value.objective, value.purpose, value.outcome, value.assessment, value.rationale, value.statement, value.explanation,
        semantic?.description, semantic?.statement, value.proposedPolicy?.statement, sourcePath(value.path), value.qualifiedName);
      const facts = [["Recorded judgments", work?.judgments], ["Observed work", work?.observedWork], ["Pending", work?.pending],
        ["Unknown", work?.unknowns || value.unknowns], ["Constraints", value.directionEvidence?.constraints],
        ["Cancelled actions", value.directionEvidence?.cancelledActions], ["Recorded decisions", value.directionEvidence?.decisions],
        ["Suggested follow-up (historical; not permission)", work?.suggestedFollowUp],
        ["Authored topics (navigation only)", work?.workTopics], ["Recorded Todo revisions (historical)", work?.todos]]
        .filter(([, items]) => Array.isArray(items) && items.length);
      // Preserve the reader's exact selectors/ranges; never reconstruct omitted
      // wording or reinterpret agent-authored text as a captured user request.
      const excerpts = (Array.isArray(value.workContentExcerpts) ? value.workContentExcerpts : [])
        .filter(entry => entry && typeof entry.text === "string").map(entry => {
          const location = `workContent.${entry.field}${entry.index == null ? "" : `[${entry.index}]`}`
            + (entry.subfield ? `.${entry.subfield}` : "") + (entry.alternativeIndex == null ? "" : `[${entry.alternativeIndex}]`);
          const todo = entry.field === "todos" ? ` · ${entry.todoId} [${entry.status}; ${entry.origin}]`
            + ["prior", "resolves", "relatedEvidence"].filter(key => Object.hasOwn(entry, key)).map(key => ` · recorded ${key}: ${JSON.stringify(entry[key])}`).join("") : "";
          return { text: entry.text, heading: ({ summary: "Recorded description", judgments: "Recorded judgment", todos: "Recorded task", observedWork: "Observed work", pending: "Pending", unknowns: "Uncertainty" })[entry.field] || "Recorded text", technicalLocation: { location, todo, start: entry.start, end: entry.end, totalCharacters: entry.totalCharacters } };
        });
      const hasDisplayText = Boolean(body || facts.length || excerpts.length);
      const firstFact = facts[0]?.[1]?.[0];
      const factPreview = firstFact && (typeof firstFact === "string" ? firstFact : first(firstFact.task, firstFact.assessment, firstFact.reason));
      const rawPreview = body || (factPreview ? `${facts[0][0]}: ${factPreview}` : "")
        || (excerpts[0] ? `${excerpts[0].heading}: ${excerpts[0].text}` : "");
      const displayTitle = humanTitle({ ...value, semantic });
      const sameText = text => String(text || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
      // Presentation deduplication only; source, digest and authority stay separate.
      const preview = sameText(rawPreview) === sameText(displayTitle) || rawPreview === value.path && displayTitle === value.path ? "" : rawPreview;
      const emptyNotice = value.kind === "ProductPolicyEvidence" && value.evidenceKind === "user-request" && value.reference
        ? "Reference-only evidence in this projection; no summary is included. This does not establish whether request text exists elsewhere."
        : value.detailCoverage === "metadata-only"
          ? "No readable text in this metadata-only projection; more may exist in the original."
          : "No supported display text is included in this projection; original availability is reported separately.";
      const conditions = [];
      if(value.claimBasis)conditions.push(`Claim basis: ${value.claimBasis}; not Canon or execution proof`);
      if(value.claimEvidence)conditions.push(`Quoted source: ${value.claimEvidence.state}${value.claimEvidence.reasonCode ? ` (${value.claimEvidence.reasonCode})` : ""}`);
      if(value.executionBinding)conditions.push(`Code binding: ${value.executionBinding.state}`);
      if(value.executionEvidence?.state!==undefined)conditions.push(`Code source: ${value.executionEvidence.state}`);
      for (const name of ["Cancelled actions", "Pending", "Unknown", "Constraints"]) {
        const items = facts.find(([heading]) => heading === name)?.[1]; if (items) conditions.push(`${name}: ${items.length}`);
      }
      for (const [name, field] of [["Recorded status", "status"], ["Recorded state", "state"], ["Review", "reviewState"]])
        if (typeof value[field] === "string" && value[field] && value[field] !== "not-applicable") conditions.push(`${name}: ${value[field]}`);
      const sourceState = state => state === "unavailable" ? "Current source bytes unavailable at export (unavailable; cause not established)"
        : state === "historical-source-bytes" ? "Cited bytes differ from export-observed bytes (historical-source-bytes)"
          : state === "current-source-bytes" ? "Cited bytes match export-observed bytes (current-source-bytes)" : `Recorded freshness: ${state}`;
      if (typeof value.freshness === "string" && value.freshness) conditions.push(sourceState(value.freshness));
      if (typeof value.sourceCurrentness?.freshness === "string" && value.sourceCurrentness.freshness && value.sourceCurrentness.freshness !== value.freshness)
        conditions.push(`Recorded source currentness: ${sourceState(value.sourceCurrentness.freshness)}`);
      for (const [name, field] of [["Recorded relationship currentness", "viewerCurrentness"], ["Recorded snapshot state", "snapshotState"]])
        if (typeof value[field] === "string" && value[field]) conditions.push(`${name}: ${value[field]}`);
      if (value.currentTraversalEligible === false) conditions.push("Not eligible for current traversal in this snapshot");
      if (historical(value) || value.origin?.layer === "sessionWork") conditions.push("Historical evidence — not live state or current permission");
      if (value.contentPartial || value.workContentCoverage?.partial || value.directionContentCoverage?.partial) conditions.push("Partial exported content");
      const todos = work?.todos || [], todoExcerpts = (value.workContentExcerpts || []).filter(entry => entry.field === "todos");
      const todoStates = [...new Set([...todos, ...todoExcerpts].map(todo => todo.status).filter(Boolean))];
      const todoCoverage = value.workContentCoverage?.fieldItems?.todos;
      const todoCoverageText = todoCoverage ? ["completeItems", "partialItems", "omittedItems"].map((key, index) =>
        `${Number.isSafeInteger(todoCoverage[key]) && todoCoverage[key] >= 0 ? todoCoverage[key] : "unknown"} ${["whole", "partial", "omitted"][index]}`).join(", ") : null;
      if (todos.length || todoExcerpts.length || value.workContentCoverage?.fieldItems?.todos?.originalItems) {
        conditions.push(`Recorded Todo states: ${todoStates.join(", ") || "not included"}; no current-state or completion inference`);
        if (todoCoverageText) conditions.push(`Todo coverage: ${todoCoverageText}`);
      }
      const notes = value.origin?.layer === "sessionWork" ? ["Agent-authored work; not a captured user utterance."]
        : value.kind === "ProjectDirection" ? ["Recorded caller-conveyed direction; not automatic transcript capture or new authority."] : [];
      if (todos.length || todoExcerpts.length) notes.push("Todo revisions remain separate historical declarations. Prior/reference currentness and unseen successors are unknown here; expand the exact original when needed.");
      // Compact typed conditions, not a semantic summary. Long originals remain
      // in the independent reader; these material qualifiers never line-clamp.
      const summaryConditions = [];
      if (value.claimBasis) summaryConditions.push(statusLabel(value.claimBasis));
      
      for (const [label, observation] of [["Claim", value.claimEvidence], ["Code", value.executionEvidence]]) {
        if (observation?.state && observation.state !== "exact-current-source-bytes") {
          summaryConditions.push(label + ": " + statusLabel(observation.state));
        }
      }
      if (value.executionBinding?.state === "file-reference-only") summaryConditions.push("Symbol not confirmed");
      for (const [heading, label] of [["Cancelled actions", "Cancelled"], ["Pending", "Pending"], ["Unknown", "Unknown"], ["Constraints", "Constraints"]]) {
        const items = facts.find(([name]) => name === heading)?.[1]; if (items) summaryConditions.push(label + ": " + items.length);
      }
      for (const [label, field] of [["Status", "status"], ["State", "state"], ["Review", "reviewState"]])
        if (typeof value[field] === "string" && value[field] && value[field] !== "not-applicable" && value[field] !== "non-canonical-source-claim") summaryConditions.push(statusLabel(value[field]));
      for (const state of new Set([value.freshness, value.sourceCurrentness?.freshness, value.viewerCurrentness, value.snapshotState].filter(state => typeof state === "string" && state))) {
        if (!["snapshot-evidence", "current-canon-bytes", "current-source-bytes", "current", "not-applicable"].includes(state)) summaryConditions.push(statusLabel(state));
      }
      if (value.currentTraversalEligible === false) summaryConditions.push("Historical or unavailable");
      if (historical(value) || value.origin?.layer === "sessionWork") summaryConditions.push("Historical record");
      if (value.contentPartial || value.workContentCoverage?.partial || value.directionContentCoverage?.partial) summaryConditions.push("Partial content");
      if (todos.length || todoExcerpts.length || value.workContentCoverage?.fieldItems?.todos?.originalItems) summaryConditions.push("Recorded tasks: " + (todoStates.map(statusLabel).filter(Boolean).join(", ") || "State not included"));
      if (todoCoverage && (!Number.isSafeInteger(todoCoverage.completeItems) || !Number.isSafeInteger(todoCoverage.partialItems) || !Number.isSafeInteger(todoCoverage.omittedItems))) summaryConditions.push("Task coverage unknown");
      else if (todoCoverage && (todoCoverage.partialItems > 0 || todoCoverage.omittedItems > 0)) summaryConditions.push("Some task details missing");
      const technicalSource = first(value.sourceReference?.path, value.path, value.provenance?.path, value.origin?.path);
      const result = { title: displayTitle, kind: kindName(value), body, facts, excerpts, preview, hasDisplayText, emptyNotice,
        technical: { ...technicalFields(value), conditions, notes }, technicalConditions: conditions, conditions: [...new Set(summaryConditions.filter(Boolean))], summaryConditions: [...new Set(summaryConditions.filter(Boolean))], notes: [], technicalNotes: notes,
        source: sourcePath(technicalSource), technicalSource,
        groups: [...(memberships.get(value.nodeId) || [])].map(key => groups.get(key)),
        excerptNotice: hasDisplayText ? "Excerpt, not a complete summary. Read the record for all wording and conditions." : "" };
      descriptions.set(value, result); return result;
    }
    function identity(value) {
      const id = value.nodeId || value.edgeId, reference = value.sourceReference || value.provenance;
      const basis = graph.basis?.graphSnapshotId || graph.sourceAnchor?.graphSnapshotId || graph.semanticGraphId;
      if (!owner || value.projectId && value.projectId !== owner || !id
        || !(value.revisionId || value.sourceSnapshotId || reference?.digest || value.origin?.digest || basis)) return null;
      return JSON.stringify([owner, layer, id, ...originKey(value.origin), value.revisionId || null, value.sourceSnapshotId || null,
        reference?.path || null, reference?.digest || null, basis || null]);
    }
    return { describe, groups, memberships, identity, anchor(id, positions) {
      for (const key of memberships.get(id) || []) { const root = groups.get(key).rootId; if (root !== id && positions.has(root)) return root; }
      return null;
    } };
  }
  const bounds = (point, extent) => ({ left: point.x - extent.left, right: point.x + extent.right, top: point.y - extent.top, bottom: point.y + extent.bottom });
  const intersects = (a, b) => a.left < a.right && a.top < a.bottom && b.left < b.right && b.top < b.bottom
    && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  function endpoint(point, toward, extent, gap = 6) {
    const dx = toward.x - point.x, dy = toward.y - point.y;
    if (!dx && !dy) return { x: point.x, y: point.y - extent.top - gap };
    const tx = dx ? (dx > 0 ? extent.right : extent.left) / Math.abs(dx) : Infinity;
    const ty = dy ? (dy > 0 ? extent.bottom : extent.top) / Math.abs(dy) : Infinity;
    const ratio = Math.min(tx, ty), length = Math.hypot(dx, dy);
    return { x: point.x + dx * ratio + dx / length * gap, y: point.y + dy * ratio + dy / length * gap };
  }
  function edgeGeometry(a, b, ae, be, offset = 0) {
    if (a.x === b.x && a.y === b.y) {
      const left = { x: a.x - ae.left / 2, y: a.y - ae.top - 6 }, right = { x: b.x + be.right / 2, y: b.y - be.top - 10 };
      const controlY = [left.y - 90 - offset, right.y - 90 - offset];
      return { path: `M ${left.x} ${left.y} C ${a.x - ae.left - 60} ${controlY[0]} ${b.x + be.right + 60} ${controlY[1]} ${right.x} ${right.y}`,
        caption: { x: a.x, y: left.y - 65 - offset }, bounds: { left: a.x - ae.left - 62, right: b.x + be.right + 62,
          top: Math.min(left.y, right.y, ...controlY) - 2, bottom: Math.max(left.y, right.y, ...controlY) + 2 } };
    }
    const length = Math.hypot(b.x - a.x, b.y - a.y), cx = (a.x + b.x) / 2 - (b.y - a.y) / length * offset,
      cy = (a.y + b.y) / 2 + (b.x - a.x) / length * offset;
    const control = { x: cx, y: cy }, start = endpoint(a, control, ae), end = endpoint(b, control, be, 10);
    return { path: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`, caption: { x: cx, y: cy - 9 },
      bounds: { left: Math.min(start.x, end.x, cx) - 2, right: Math.max(start.x, end.x, cx) + 2, top: Math.min(start.y, end.y, cy) - 2, bottom: Math.max(start.y, end.y, cy) + 2 } };
  }
  function groupGeometry(groups, memberships, points) {
    // Camera redraw depends on visible IDs, not the full exported membership
    // inventory. Stable insertion order is retained without scanning all groups.
    const result = [], candidates = new Map();
    for (const id of points.keys()) for (const key of memberships.get(id) || []) {
      const group = groups.get(key); if (!group?.members.has(id)) continue;
      if (!candidates.has(key)) candidates.set(key, { group, shown: [] }); candidates.get(key).shown.push(id);
    }
    for (const { group, shown } of [...candidates.values()].sort((a, b) => a.group.order - b.group.order)) {
      const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const id of shown) {
        const r = points.get(id); box.left = Math.min(box.left, r.left - 18); box.right = Math.max(box.right, r.right + 18);
        box.top = Math.min(box.top, r.top - 35); box.bottom = Math.max(box.bottom, r.bottom + 18);
      }
      const shared = shown.some(id => memberships.get(id)?.size > 1);
      const intruder = [...points].some(([id, rectangle]) => !group.members.has(id) && intersects(box, rectangle));
      result.push({ ...group, box, shown: shown.length, exported: group.members.size, enclosure: !shared && !intruder });
    }
    return result;
  }
  return { create, title, humanTitle, kindName, kindLabel, statusLabel, sourcePath, relationLabel, comparisonSide, factText, technicalFields, historical, bounds, intersects, endpoint, edgeGeometry, groupGeometry };
})();
