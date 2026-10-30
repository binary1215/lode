import crypto from "node:crypto";
import { boundedPossibleMoves } from "./lineage-moves.mjs";
import { inspectProject } from "./lode-core.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { queryTemporalProvenanceGraph } from "./temporal-provenance.mjs";
import { createWorldModelStoreAdapter } from "./world-model-store.mjs";
import { inspectWorldModel, readWorldModel, readWorldModelSnapshot } from "./world-model.mjs";
import { inspectProductPolicyEvidenceCurrentness } from "./product-policy-evidence.mjs";
import { readProductPolicyCandidate } from "./product-policy.mjs";

export const GRAPH_LINEAGE_VIEW_VERSION = "0.2.0";
const PAGE_LIMIT_MAX = 100;
const TRACE_ARTIFACT_LIMIT = 128;

const fail = (message, code = "GRAPH_LINEAGE_ERROR") => { const error = new Error(message); error.code = code; throw error; };
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const canonicalJson = (value) => JSON.stringify(canonical(value));

function authority() {
  return {
    plane: "P4-derived-view",
    persistence: "none",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    ordinaryWorkBlocked: false,
  };
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for Graph lineage inspection; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function normalizeLimit(value, fallback, maximum, label) {
  const selected = value == null ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) fail(`${label} must be from 1 to ${maximum}.`, "INVALID_GRAPH_LINEAGE_LIMIT");
  return selected;
}

function snapshotDescriptor(snapshot, currentWorldModelId, currentParentSourceIds) {
  const graph = snapshot.temporalProvenanceGraph;
  const tier = snapshot.worldModelId === currentWorldModelId
    ? "hot"
    : currentParentSourceIds.has(graph.sourceSnapshotId) ? "warm" : "cold";
  return {
    worldModelId: snapshot.worldModelId,
    worldModelHash: snapshot.worldModelHash,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    parentSourceSnapshotIds: graph.parentSourceSnapshotIds,
    productModelId: snapshot.productModel?.productModelId || null,
    tier,
  };
}

export async function inspectGraphLineage({ root = ".", cursor = "", limit = 25, storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const selectedLimit = normalizeLimit(limit, 25, PAGE_LIMIT_MAX, "Graph lineage page limit");
  const current = (await readWorldModel({ root: inspected.project.projectRoot, storeAdapter }));
  const adapter = createWorldModelStoreAdapter({ projectRoot: inspected.project.projectRoot, adapter: storeAdapter, storage: inspected.storage });
  const ids = (await adapter.listSnapshotIds());
  const start = cursor ? ids.findIndex((id) => id === cursor) + 1 : 0;
  if (cursor && start === 0) fail("Graph lineage cursor is not a retained World Model snapshot.", "INVALID_GRAPH_LINEAGE_CURSOR");
  const pageIds = ids.slice(start, start + selectedLimit);
  const currentParents = new Set(current.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds);
  const snapshots = (await Promise.all(pageIds.map(async (worldModelId) => (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId, storeAdapter: adapter })).snapshot)));
  const entries = snapshots.map((snapshot) => snapshotDescriptor(snapshot, current.snapshot.worldModelId, currentParents));
  const segmentPayload = { projectId: inspected.project.projectId, cursor: cursor || null, entries };
  const segmentHash = digest(canonicalJson(segmentPayload));
  return {
    kind: "GraphLineageStatusProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-graph-lineage-view"), version: GRAPH_LINEAGE_VIEW_VERSION },
    projectId: inspected.project.projectId,
    currentWorldModelId: current.snapshot.worldModelId,
    totalRetainedSnapshots: ids.length,
    segment: { segmentId: `graph-lineage-segment-${segmentHash.slice(0, 24)}`, segmentHash, entries },
    nextCursor: start + pageIds.length < ids.length ? pageIds.at(-1) : null,
    tiers: {
      hot: "current verified World Model snapshot",
      warm: "direct SourceSnapshot parents of the current graph",
      cold: "other retained content-addressed snapshots",
      persistedSegmentArtifacts: false,
    },
    authority: authority(),
  };
}

async function selectedSnapshot({ root, worldModelId, requireCurrent, storeAdapter }) {
  if (worldModelId) return (await readWorldModelSnapshot({ root, worldModelId, storeAdapter })).snapshot;
  if (requireCurrent) {
    const inspected = (await inspectWorldModel({ root, storeAdapter }));
    if (inspected.status !== "current") fail("Current World Model is stale; refresh it or select an exact retained snapshot.", "WORLD_MODEL_STALE");
    return inspected.snapshot;
  }
  return (await readWorldModel({ root, storeAdapter })).snapshot;
}

export function projectExecutionLineageOverlay(root, graphResult) {
  const initial = new Set();
  for (const node of graphResult.nodes) {
    if (node.kind === "ExecutionLineageReference" && node.referencedArtifactId) initial.add(node.referencedArtifactId);
    if (node.kind === "ChangeSet") for (const field of ["wholePlanId", "executionContractId", "resultPacketId", "executionReviewDecisionId"]) if (node[field]) initial.add(node[field]);
  }
  const queue = [...initial].sort();
  const seen = new Set();
  const artifacts = [];
  const edges = [];
  const unavailable = [];
  while (queue.length && artifacts.length < TRACE_ARTIFACT_LIMIT) {
    const artifactId = queue.shift();
    if (seen.has(artifactId)) continue;
    seen.add(artifactId);
    try {
      const artifact = readLineageArtifact({ root, artifactId }).artifact;
      artifacts.push({
        artifactId,
        kind: artifact.kind,
        artifactHash: artifact.artifactHash,
        authority: artifact.authority,
        instructionAuthority: artifact.instructionAuthority,
        promotionAuthority: artifact.promotionAuthority,
      });
      for (const link of artifact.lineage || []) {
        edges.push({ relation: link.relation, from: artifactId, to: link.targetId });
        if (!seen.has(link.targetId)) queue.push(link.targetId);
      }
      queue.sort();
    } catch (error) {
      unavailable.push({ artifactId, reasonCode: String(error?.code || "LINEAGE_ARTIFACT_UNAVAILABLE") });
    }
  }
  return {
    artifacts: artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    edges: edges.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    unavailable: unavailable.sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    omittedArtifactCount: queue.length,
    authority: authority(),
  };
}

export async function traceGraphLineage({
  root = ".", worldModelId = "", anchorId = "", query = "", depth = 2,
  maxNodes = 100, maxEdges = 200, includeExecution = true, storeAdapter = null,
} = {}) {
  const inspected = readyProject(root);
  if (!anchorId && !String(query || "").trim()) fail("Graph lineage trace requires an exact anchorId or discovery query.", "GRAPH_LINEAGE_ANCHOR_REQUIRED");
  const snapshot = (await selectedSnapshot({ root: inspected.project.projectRoot, worldModelId, requireCurrent: !worldModelId, storeAdapter }));
  const graph = snapshot.temporalProvenanceGraph;
  const result = queryTemporalProvenanceGraph(graph, {
    anchorIds: anchorId ? [anchorId] : null,
    query: anchorId ? null : query,
    expectedGraphSnapshotId: graph.graphSnapshotId,
    freshness: ["current", "stale", "historical"],
    includeUnreviewedCandidates: true,
    depth,
    maxNodes,
    maxEdges,
  });
  const policyEvidenceCurrentness = result.nodes
    .filter((node) => node.kind === "ProductPolicyCandidate")
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .map((node) => inspectProductPolicyEvidenceCurrentness({
      projectRoot: inspected.project.projectRoot,
      candidate: readProductPolicyCandidate({ root: inspected.project.projectRoot, candidateId: node.nodeId }).candidate,
    }));
  return {
    kind: "GraphLineageTraceProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-graph-lineage-view"), version: GRAPH_LINEAGE_VIEW_VERSION },
    projectId: inspected.project.projectId,
    worldModelId: snapshot.worldModelId,
    graphSnapshotId: graph.graphSnapshotId,
    anchorMode: anchorId ? "exact" : "discovery",
    graph: result,
    policyEvidenceCurrentness,
    executionLineage: includeExecution ? projectExecutionLineageOverlay(inspected.project.projectRoot, result) : null,
    semantics: {
      discoverySelectsAuthority: false,
      graphWritesRecoveryDirection: false,
      executionCompletionImpliesIntegration: false,
    },
    authority: authority(),
  };
}

function boundedChanges(values, limit) {
  return { count: values.length, items: values.slice(0, limit), omittedCount: Math.max(0, values.length - limit) };
}

function endpointContinuity(node, graph) {
  const logicalEntityId = node?.logicalEntityId || node?.nodeId || null;
  return {
    logicalEntityId,
    kind: node?.kind || null,
    generation: graph.logicalLineageState?.continuityGenerationByLogicalEntityId?.[logicalEntityId] || 0,
    unknown: Boolean(graph.logicalLineageState?.continuityUnknownLogicalEntityIds?.includes(logicalEntityId)),
  };
}

// This is an explanation of verified records, not a semantic-continuity judgment.
// Only global snapshot membership is discounted. All other fields, exact
// endpoints, producer changes and endpoint continuity remain comparison inputs.
function explainGraphChanges(beforeGraph, afterGraph, beforeNodes, afterNodes, beforeEdges, afterEdges, changes, limit) {
  const nodeContent = (node, graph) => {
    const { sourceSnapshotId, ...record } = node;
    return canonicalJson({ record, continuity: endpointContinuity(node, graph) });
  };
  const observationNodes = [], contentNodes = [];
  for (const id of changes.changedNodes) {
    (nodeContent(beforeNodes.get(id), beforeGraph) === nodeContent(afterNodes.get(id), afterGraph)
      ? observationNodes : contentNodes).push(id);
  }
  const beforeEndpoints = new Map(beforeGraph.nodes.map(node => [node.nodeId, node]));
  const afterEndpoints = new Map(afterGraph.nodes.map(node => [node.nodeId, node]));
  const relationContent = (edge, graph, endpoints) => {
    const { edgeId, sourceSnapshotId, ...record } = edge;
    return canonicalJson({ record, projectId: graph.projectId, protocol: graph.protocol,
      relationAnalysisBasis: graph.relationAnalysisBasis ?? null,
      from: endpointContinuity(endpoints.get(edge.from), graph),
      to: endpointContinuity(endpoints.get(edge.to), graph) });
  };
  const group = (ids, edges, graph, endpoints) => {
    const groups = new Map();
    for (const id of ids) {
      const key = relationContent(edges.get(id), graph, endpoints);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    return groups;
  };
  const removed = group(changes.removedEdges, beforeEdges, beforeGraph, beforeEndpoints);
  const added = group(changes.addedEdges, afterEdges, afterGraph, afterEndpoints);
  const observationRelations = [], matchedBefore = new Set(), matchedAfter = new Set();
  let ambiguousGroups = 0;
  for (const [key, fromIds] of removed) {
    const toIds = added.get(key);
    if (!toIds) continue;
    if (fromIds.length !== 1 || toIds.length !== 1) { ambiguousGroups++; continue; }
    matchedBefore.add(fromIds[0]); matchedAfter.add(toIds[0]);
    observationRelations.push({ fromEdgeId: fromIds[0], toEdgeId: toIds[0] });
  }
  for (const [id, before] of beforeEdges) {
    const after = afterEdges.get(id);
    if (after && before.sourceSnapshotId !== after.sourceSnapshotId
      && relationContent(before, beforeGraph, beforeEndpoints) === relationContent(after, afterGraph, afterEndpoints)) {
      observationRelations.push({ fromEdgeId: id, toEdgeId: id });
    }
  }
  observationRelations.sort((a, b) => a.fromEdgeId < b.fromEdgeId ? -1 : a.fromEdgeId > b.fromEdgeId ? 1
    : a.toEdgeId < b.toEdgeId ? -1 : a.toEdgeId > b.toEdgeId ? 1 : 0);
  const producer = graph => ({ protocol: graph.protocol,
    relationAnalysisBasis: graph.relationAnalysisBasis ?? null,
    edgeProducers: [...new Set(graph.edges.map(edge => canonicalJson([edge.producer, edge.producerVersion])))].sort() });
  const fromProducer = producer(beforeGraph), toProducer = producer(afterGraph);
  return {
    comparison: "exact-record-fields-except-global-snapshot-membership",
    changedNodes: { content: boundedChanges(contentNodes, limit), observationOnly: boundedChanges(observationNodes, limit) },
    relations: {
      contentAdded: boundedChanges(changes.addedEdges.filter(id => !matchedAfter.has(id)), limit),
      contentRemoved: boundedChanges(changes.removedEdges.filter(id => !matchedBefore.has(id)), limit),
      observationOnly: boundedChanges(observationRelations, limit), ambiguousGroups,
    },
    producerTransition: { changed: canonicalJson(fromProducer) !== canonicalJson(toProducer), from: fromProducer, to: toProducer },
    rawChangesPreserved: true,
    examples: "bounded-first-examples-within-the-same-scope; raw-changes-retain-their-existing-pagination",
    semanticContinuityClaimed: false,
  };
}

export async function diffGraphLineage({ root = ".", fromWorldModelId, toWorldModelId, limit = 100, storeAdapter = null, scopePaths = null, cursor = "" } = {}) {
  const inspected = readyProject(root);
  const selectedLimit = normalizeLimit(limit, 100, 500, "Graph lineage diff limit");
  if (fromWorldModelId === toWorldModelId) fail("Graph lineage diff requires two different snapshots.", "GRAPH_LINEAGE_DIFF_IDENTICAL");
  const scoped = scopePaths !== null || Boolean(cursor);
  let selectedPaths = null;
  if (scopePaths !== null) {
    if (!Array.isArray(scopePaths) || !scopePaths.length || scopePaths.length > 500 || scopePaths.some(p => typeof p !== "string" || !p || p.includes(String.fromCharCode(92)) || p.includes(String.fromCharCode(0)) || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some(s => !s || s === "." || s === ".."))) fail("Diff scope requires normalized exact repository paths.", "INVALID_GRAPH_LINEAGE_SCOPE");
    selectedPaths = [...new Set(scopePaths)].sort();
  }
  const fromSnapshot = (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId: fromWorldModelId, storeAdapter })).snapshot;
  const toSnapshot = (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId: toWorldModelId, storeAdapter })).snapshot;
  const pageBasis = { projectId: inspected.project.projectId, from: fromSnapshot.worldModelId, fromHash: fromSnapshot.worldModelHash,
    to: toSnapshot.worldModelId, toHash: toSnapshot.worldModelHash, paths: selectedPaths, order: "lineage-diff-v1" };
  let previousEnds = {};
  if (cursor) {
    if (typeof cursor !== "string" || cursor.length > 131072 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail("Invalid diff page cursor.", "INVALID_GRAPH_LINEAGE_CURSOR");
    let parsed; try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { fail("Invalid diff page cursor.", "INVALID_GRAPH_LINEAGE_CURSOR"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Invalid diff page cursor.", "INVALID_GRAPH_LINEAGE_CURSOR");
    if (canonicalJson(parsed.basis) !== canonicalJson(pageBasis) || !parsed.ends || typeof parsed.ends !== "object" || Array.isArray(parsed.ends)
      || Object.keys(parsed.ends).some(k => !["addedNodes","removedNodes","changedNodes","addedEdges","removedEdges","possibleMoves"].includes(k))
      || Object.entries(parsed.ends).some(([k,v]) => k === "possibleMoves" ? v !== null && (!v || typeof v.key !== "string" || v.key.length > 100000 || !Number.isSafeInteger(v.ordinal) || v.ordinal < 0) : typeof v !== "string" || v.length > 256)) fail("Diff cursor belongs to different endpoints, scope or order.", "INVALID_GRAPH_LINEAGE_CURSOR");
    previousEnds = parsed.ends;
  }
  const pathSet = selectedPaths ? new Set(selectedPaths) : null;
  const incidentIds = pathSet ? new Set() : null;
  if (pathSet) for (const graph of [fromSnapshot.temporalProvenanceGraph, toSnapshot.temporalProvenanceGraph]) {
    for (const node of graph.nodes) if (pathSet.has(node.path)) incidentIds.add(node.nodeId);
  }
  const nodeSelected = n => pathSet.has(n.path);
  const edgeSelected = e => incidentIds.has(e.from) || incidentIds.has(e.to) || pathSet.has(e.evidence?.path);
  const beforeNodes = new Map((pathSet ? fromSnapshot.temporalProvenanceGraph.nodes.filter(nodeSelected) : fromSnapshot.temporalProvenanceGraph.nodes).map((node) => [node.nodeId, node]));
  const afterNodes = new Map((pathSet ? toSnapshot.temporalProvenanceGraph.nodes.filter(nodeSelected) : toSnapshot.temporalProvenanceGraph.nodes).map((node) => [node.nodeId, node]));
  const beforeEdges = new Map((pathSet ? fromSnapshot.temporalProvenanceGraph.edges.filter(edgeSelected) : fromSnapshot.temporalProvenanceGraph.edges).map((edge) => [edge.edgeId, edge]));
  const afterEdges = new Map((pathSet ? toSnapshot.temporalProvenanceGraph.edges.filter(edgeSelected) : toSnapshot.temporalProvenanceGraph.edges).map((edge) => [edge.edgeId, edge]));
  const addedNodes = [...afterNodes.keys()].filter((id) => !beforeNodes.has(id)).sort();
  const removedNodes = [...beforeNodes.keys()].filter((id) => !afterNodes.has(id)).sort();
  const changedNodes = [...afterNodes.keys()].filter((id) => beforeNodes.has(id) && canonicalJson(afterNodes.get(id)) !== canonicalJson(beforeNodes.get(id))).sort();
  const addedEdges = [...afterEdges.keys()].filter((id) => !beforeEdges.has(id)).sort();
  const removedEdges = [...beforeEdges.keys()].filter((id) => !afterEdges.has(id)).sort();
  const beforeFiles = selectedPaths ? fromSnapshot.files.filter(f => pathSet.has(f.path)) : fromSnapshot.files;
  const afterFiles = selectedPaths ? toSnapshot.files.filter(f => pathSet.has(f.path)) : toSnapshot.files;
  const moves = boundedPossibleMoves(beforeFiles, afterFiles, selectedLimit, scoped ? { after: previousEnds.possibleMoves || null } : null);
  const ends = {}, remaining = {};
  function pageValues(name, values) {
    if (!scoped) return boundedChanges(values, selectedLimit);
    const eligible = previousEnds[name] ? values.filter(id => id > previousEnds[name]) : values;
    const items = eligible.slice(0, selectedLimit);
    ends[name] = items.at(-1) || previousEnds[name] || "";
    remaining[name] = Math.max(0, eligible.length - items.length);
    return { count: values.length, items, omittedCount: values.length - items.length };
  }
  const changes = { addedNodes: pageValues("addedNodes", addedNodes), removedNodes: pageValues("removedNodes", removedNodes),
    changedNodes: pageValues("changedNodes", changedNodes), addedEdges: pageValues("addedEdges", addedEdges), removedEdges: pageValues("removedEdges", removedEdges),
    possibleMoves: { count: moves.count, items: moves.items, omittedCount: moves.omittedCount } };
  if (scoped) { ends.possibleMoves = moves.endAfter; remaining.possibleMoves = moves.remainingCount; }
  const nextCursor = scoped && Object.values(remaining).some(n => n > 0) ? Buffer.from(canonicalJson({basis:pageBasis,ends})).toString("base64url") : null;
  return {
    kind: "GraphLineageDiffProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-graph-lineage-view"), version: scoped ? "0.3.0" : GRAPH_LINEAGE_VIEW_VERSION },
    projectId: inspected.project.projectId,
    from: { worldModelId: fromSnapshot.worldModelId, graphSnapshotId: fromSnapshot.temporalProvenanceGraph.graphSnapshotId, sourceSnapshotId: fromSnapshot.temporalProvenanceGraph.sourceSnapshotId },
    to: { worldModelId: toSnapshot.worldModelId, graphSnapshotId: toSnapshot.temporalProvenanceGraph.graphSnapshotId, sourceSnapshotId: toSnapshot.temporalProvenanceGraph.sourceSnapshotId },
    changes,
    changeExplanation: explainGraphChanges(fromSnapshot.temporalProvenanceGraph, toSnapshot.temporalProvenanceGraph,
      beforeNodes, afterNodes, beforeEdges, afterEdges, { changedNodes, addedEdges, removedEdges }, selectedLimit),
    ...(scoped ? { scope: { paths: selectedPaths, verification: "full-endpoint-snapshots", counts: "exact-within-selected-path-scope",
      edges: "incident-to-scoped-nodes-or-exact-evidence-path", possibleMoves: "both-paths-within-scope",
      globalChangeCounts: selectedPaths ? "not-computed" : "exact", rootContextChanged: fromSnapshot.sourceDigest !== toSnapshot.sourceDigest },
      page: { remaining, nextCursor, endpointsFixed: true } } : {}),
    semantics: {
      exactContentPossibleMoveIsIdentityProof: false,
      semanticContinuityRequiresHeadProposal: true,
      reviewRequiredOnlyIfContinuityIsPromoted: true,
    },
    authority: authority(),
  };
}
