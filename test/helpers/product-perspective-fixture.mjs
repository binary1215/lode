// Domain-neutral frozen presentation fixture; never a Product writer or authority.
export function productPerspectiveFixture(extraWork = 0) {
  const projectId = "synthetic-product", a = "a".repeat(64), b = "b".repeat(64), d = "d".repeat(64);
  const origin = { layer: "product", path: ".lode/context/product-model.json", digest: d };
  const verified = { projectId, integrity: "verified", views: ["product", "work"], freshness: "snapshot-evidence" };
  const product = (nodeId, kind, key, more = {}) => ({ ...verified, nodeId, kind, key, revisionId: "model-B", origin, sourceReference: { artifactId: "model-B", path: origin.path, digest: d, entityKey: key }, ...more });
  const worldOrigin = { layer: "world", worldModelId: "world-1", graphSnapshotId: "graph-1" };
  const world = (nodeId, kind, more = {}) => ({ ...verified, nodeId, kind, sourceSnapshotId: "source-1", origin: worldOrigin, ...more });
  const feature = product("feature-current", "Feature", "export", { name: "Export a report", description: "Users can export a portable report with its exact evidence.", featureGroupKeys: ["reports"], governedBy: [{ kind: "Constraint", key: "read-only" }] });
  const work = (id, summary, refs = []) => ({ ...verified, nodeId: id, kind: "Evidence", subtype: "SessionWorkEvidence", sessionId: "synthetic-session", origin: { layer: "sessionWork", path: ".lode/sessions/synthetic/work/" + id + ".json", digest: a }, sourceReference: { path: ".lode/sessions/synthetic/work/" + id + ".json", digest: a }, workContent: { summary, pending: ["Historical open question; not current Todo"], unknowns: ["Outcome not observed"] }, referenceEvidence: refs });
  const nodes = [feature, product("group", "FeatureGroup", "reports", { name: "Reports", description: "Portable evidence views" }),
    product("constraint", "Constraint", "read-only", { name: "Read only", statement: "Exploration must not change originals" }),
    world("source-1", "SourceSnapshot", { sourceSnapshotId: undefined, productModelId: "model-B" }), world("feature-world", "Feature", { key: "export" }),
    world("feature-revision", "FeatureRevision", { key: "export", logicalEntityId: "feature-world", semantic: { name: "Export a report", description: "Users can export a portable report with its exact evidence." } }),
    world("file", "File", { path: "src/report.mjs" }), world("file-revision", "FileRevision", { path: "src/report.mjs", digest: b }),
    work("work-root", "Investigate portable export"), work("work-cited", "Keep exact source identity", [{ kind: "source", path: "src/report.mjs", digest: b, status: "intact-retained-original" }]),
    work("work-wrong", "UNRELATED VERSION", [{ kind: "source", path: "src/report.mjs", digest: a }]), work("work-container", "CONTAINER IS NOT EVERY FEATURE"),
    product("feature-other-model", "Feature", "export", { revisionId: "model-other", name: "Export a report", description: "OTHER MODEL MUST NOT JOIN" }),
    product("feature-other-project", "Feature", "export", { projectId: "other-project", name: "Export a report" })];
  const edge = (id, from, to, type) => ({ edgeId: id, from, to, type, authorityClass: type === "IMPLEMENTS" || type === "VERIFIED_BY" ? "reviewed" : "derived", provenance: { ...worldOrigin }, sourceSnapshotId: "source-1" });
  const edges = [edge("current", "feature-world", "feature-revision", "CURRENT_REVISION"), edge("mapping", "file", "feature-world", "IMPLEMENTS"),
    edge("file-current", "file", "file-revision", "HAS_REVISION"), edge("root", "work-cited", "work-root", "DECLARES_WORK_ROOT"),
    edge("prior", "work-cited", "work-root", "FOLLOWS_WORK_EVIDENCE"), edge("self", "work-root", "work-root", "FOLLOWS_WORK_EVIDENCE"), edge("cycle", "work-root", "work-cited", "FOLLOWS_WORK_EVIDENCE")];
  for (let i = 0; i < extraWork; i++) nodes.push(work("extra-" + i, "Recorded investigation " + i, [{ kind: "source", path: "src/report.mjs", digest: b }]));
  const delta = (review, before, after, beforeText, afterText) => ({ review: { nodeId: review, reference: { path: review + ".json", digest: d } }, before: { nodeId: before }, after: { nodeId: after }, rationale: "Keep portable reports tied to exact evidence", status: "exact-recorded-model-delta", changes: [
    { field: "features", key: "export", before: { name: "Export a report", description: beforeText, status: "planned" }, after: { name: "Export a report", description: afterText, status: "active" } },
    { field: "features", key: "unrelated", before: null, after: { description: "UNRELATED ENTITY DELTA" } }], omittedChangeCount: 0 });
  const comparison = { status: "observed", scope: "recorded-changeset-snapshot-pair", before: { digest: a }, after: { digest: b }, diff: { changed: true, before: { startLine: 1, text: "export const format = 'old';" }, after: { startLine: 1, text: "export const format = 'portable';" } } };
  const contextLineage = { projectId, status: "partial-recorded-context", events: [], recordedReasons: [], gaps: [], files: [{ path: "src/report.mjs", current: { digest: b }, associations: [], comparisons: [comparison], unrecordedIntervals: "Other unsaved changes remain unknown." }],
    canonChanges: [delta("review-AB", "model-A", "model-B", "Old format", feature.description), delta("review-BC", "model-B", "model-C", feature.description, "Next retained format"), delta("review-wrong", "model-X", "model-Y", "WRONG MODEL PAIR", "WRONG MODEL PAIR")] };
  return { kind: "GraphExplorerSnapshot", schemaVersion: 1, authorityPlane: "P4-derived-view", runtimeAuthority: false, project: { projectId }, generatedAt: "2026-10-28T00:00:00Z", graph: { nodes, edges, contextLineage, initialNodeId: feature.nodeId, coverage: { state: "synthetic-display-fixture" } }, codeGraph: { nodes: [], edges: [], status: "unavailable" }, originals: {}, history: { status: "not-requested", entries: [] } };
}
