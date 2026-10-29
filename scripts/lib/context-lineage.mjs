import path from "node:path";
import { canonicalGraphJson, projectGraphDigest, readGraphRecord, safeGraphFile } from "./discovery-index.mjs";
import { relativeProjectArtifact } from "./project-storage-format.mjs";
import { LocalJsonWorldModelStoreAdapter, createLocalReadOnlyWorldModelStoreAdapter } from "./world-model-store.mjs";
import { readWorldModelForDiscovery } from "./world-model.mjs";
import { createContextSourceReader } from "./context-source-reader.mjs";
import { compareExactSourceVersions } from "./context-source-delta.mjs";
import { readContextDocumentLinks } from "./context-document-links.mjs";

const repositoryPath = value => typeof value === "string" && value && !/^(?:\.head|\.lode|\.git)(?:\/|$)/i.test(value);
const validDigest = value => /^[a-f0-9]{64}$/.test(value || "");
const reference = node => ({ nodeId: node.nodeId, kind: node.kind, sessionId: node.sessionId || null, reference: node.sourceReference, reviewState: node.reviewState, freshness: node.freshness });

// A private, non-persisted explanation over the existing query selection. It
// does not invent edges, perform collection, select a Session or change Canon.
export async function explainContextLineage({ root, project, storage, selection }) {
  if (!selection.query.details) return null;
  const requested = [...new Set([...selection.query.paths,
    ...selection.nodes.map(node => node.path).filter(repositoryPath),
    ...selection.nodes.flatMap(node => node.referenceEvidence || []).filter(ref => ref.kind === "source").map(ref => ref.path).filter(repositoryPath)])];
  const relevantReviews = selection.nodes.filter(node => node.kind === "ReviewDecision" && (node.previousProductModelId || node.baseProductModelId || node.resultingProductModelId));
  const eventNodes = selection.nodes.filter(node => node.kind === "ProjectDirection" || node.workContent || node.kind === "ReviewDecision" || node.kind === "ResultPacket" || node.kind === "ChangeSet");
  if (!requested.length && !relevantReviews.length && !eventNodes.length) return null;
  if (selection.basis?.projectId && selection.basis.projectId !== project.projectId) throw Object.assign(new Error("Context Project mismatch"), { code: "CONTEXT_LINEAGE_PROJECT_MISMATCH" });
  const sources = createContextSourceReader(root, project.projectId, { storage,
    bundleHints: selection.nodes.map(node => node.payload?.bundleKey).filter(Boolean) }), files = [], gaps = [], canonChanges = [];
  const originals = new Map();
  const documentSources = new Map();
  function original(node) {
    if (originals.has(node.nodeId)) return originals.get(node.nodeId);
    const ref = node.sourceReference;
    if (!ref?.path || !validDigest(ref.digest)) return null;
    try {
      const read = readGraphRecord(root, ref.path);
      if (read.digest !== ref.digest || read.document.projectId && read.document.projectId !== project.projectId) throw Object.assign(new Error("Original drift"), { code: "CONTEXT_ORIGINAL_MISMATCH" });
      originals.set(node.nodeId, read.document); return read.document;
    } catch (error) { gaps.push({ nodeId: node.nodeId, reference: ref, reasonCode: error.code || "CONTEXT_ORIGINAL_UNAVAILABLE" }); return null; }
  }
  // Reuse the safe local World reader only when an already recorded ChangeSet
  // needs exact snapshot metadata. Never choose the configured external store.
  let snapshots = null;
  const snapshotKey = endpoint => JSON.stringify([endpoint?.sourceSnapshotId, endpoint?.graphSnapshotId]);
  const endpointKey = endpoint => JSON.stringify([endpoint?.worldModelId || null, endpoint?.sourceSnapshotId, endpoint?.graphSnapshotId]);
  async function snapshotsFor(changes) {
    if (snapshots) return snapshots;
    snapshots = new Map();
    const adapter = createLocalReadOnlyWorldModelStoreAdapter({ projectRoot: root, storage });
    adapter.readPointer = () => null; // explicit historical IDs, no current selection/read
    const endpoints = [...new Map(changes.flatMap(change => [change.before, change.after]).filter(Boolean).map(endpoint => [endpointKey(endpoint), endpoint])).values()];
    const pendingPairs = endpoints.filter(endpoint => !endpoint.worldModelId);
    const matches = (snapshot, endpoint) => snapshotKey(snapshot.temporalProvenanceGraph) === snapshotKey(endpoint);
    const read = async id => {
      safeGraphFile(root, path.relative(root, adapter.snapshotLocation(id)).replaceAll("\\", "/"));
      return (await readWorldModelForDiscovery({ root, worldModelId: id, storeAdapter: adapter })).snapshot;
    };
    // A recorded World ID is a direct address, independent of inventory order.
    // Older ChangeSets contain only a Source/Graph pair: never manufacture a
    // World ID from either member of that pair or choose today's pointer.
    for (const endpoint of endpoints.filter(item => item.worldModelId)) {
      try {
        const snapshot = (await read(endpoint.worldModelId));
        if (!matches(snapshot, endpoint)) throw Object.assign(new Error("Recorded snapshot pair differs from World"), { code: "RETAINED_SOURCE_SNAPSHOT_PAIR_MISMATCH" });
        snapshots.set(endpointKey(endpoint), snapshot);
      } catch (error) { gaps.push({ ...endpoint, lookup: "recorded-exact-world-id", reasonCode: error.code || "RETAINED_SOURCE_SNAPSHOT_UNAVAILABLE" }); }
    }
    if (!pendingPairs.length) return snapshots;
    try {
      safeGraphFile(root, relativeProjectArtifact(storage, "world-model", "snapshots"));
      const ids = (await adapter.listSnapshotIds());
      let inspected = 0;
      for (const id of ids.slice(0, 128)) {
        inspected++;
        try {
          const snapshot = (await read(id));
          for (const endpoint of pendingPairs) if (!snapshots.has(endpointKey(endpoint)) && matches(snapshot, endpoint)) snapshots.set(endpointKey(endpoint), snapshot);
        } catch (error) { gaps.push({ worldModelId: id, reasonCode: error.code || "RETAINED_SOURCE_SNAPSHOT_UNAVAILABLE" }); }
        if (pendingPairs.every(endpoint => snapshots.has(endpointKey(endpoint)))) break;
      }
      for (const endpoint of pendingPairs.filter(item => !snapshots.has(endpointKey(item)))) gaps.push({ ...endpoint, lookup: "recorded-source-graph-pair",
        reasonCode: ids.length > inspected ? "RETAINED_SOURCE_SNAPSHOT_LOOKUP_BUDGET_REACHED" : "REQUESTED_RETAINED_SOURCE_SNAPSHOT_NOT_FOUND",
        inspectedSnapshotCount: inspected, retainedSnapshotCount: ids.length, uninspectedSnapshotCount: Math.max(0, ids.length - inspected), inspectedSnapshotLimit: 128,
        absenceEstablished: false });
    } catch (error) { gaps.push({ reasonCode: error.code || "RETAINED_SOURCE_SNAPSHOTS_UNAVAILABLE" }); }
    return snapshots;
  }
  const changes = selection.nodes.filter(node => node.kind === "ChangeSet").map(node => ({ node, document: original(node) })).filter(item => item.document);
  const recordedReasons = selection.nodes.flatMap(node => {
    const work = node.workContent;
    if (work) return (work.judgments || []).map(judgment => ({ classification: "recorded-work-judgment-not-proven-change-cause", ...reference(node),
      assessment: judgment.assessment, reason: judgment.reason, alternatives: judgment.alternatives, contentPartial: Boolean(node.contentPartial) }));
    if (typeof node.rationale === "string") return [{ classification: "recorded-rationale-for-its-original-subject", ...reference(node), rationale: node.rationale,
      contentPartial: Boolean(node.contentPartial), contentCoverage: node.contentCoverage?.rationale || null }];
    return [];
  });
  for (const relative of requested.slice(0, selection.query.maxNodes)) {
    const current = await sources.read(relative), citations = selection.nodes.flatMap(node => (node.referenceEvidence || [])
      .filter(ref => ref.kind === "source" && ref.path === relative).map(ref => ({ node, ref })));
    const references = selection.nodes.filter(node => node.path === relative && validDigest(node.digest)).map(node => ({ node, ref: { path: relative, digest: node.digest } }));
    if (/\.(?:md|markdown)$/i.test(relative)) {
      const exact = [...citations, ...references];
      if (!exact.length && current.digest) exact.push({ node: null, ref: { path: relative, digest: current.digest } });
      for (const { node, ref } of exact) if (validDigest(ref.digest)) {
        const key = JSON.stringify([ref.path, ref.digest]);
        if (!documentSources.has(key)) documentSources.set(key, { path: ref.path, digest: ref.digest, citedBy: [] });
        if (node && !documentSources.get(key).citedBy.some(item => item.nodeId === node.nodeId)) documentSources.get(key).citedBy.push(reference(node));
      }
    }
    const associations = citations.map(({ node, ref }) => ({ ...reference(node), classification: "explicit-source-citation-not-decision-cause", source: ref }));
    const comparisons = [], compared = new Set();
    for (const { node, document } of changes) {
      const recorded = document.changes.filter(change => change.path === relative);
      if (!recorded.length) continue;
      const retained = (await snapshotsFor(changes.map(item => item.document)));
      const before = retained.get(endpointKey(document.before));
      const after = retained.get(endpointKey(document.after));
      const exact = (snapshot, endpoint) => {
        if (!snapshot || snapshot.temporalProvenanceGraph.graphSnapshotId !== endpoint.graphSnapshotId) return null;
        return snapshot.files.find(file => file.path === relative) || null;
      };
      const oldFile = exact(before, document.before), newFile = exact(after, document.after);
      const bindVersion = async (snapshot, file) => {
        if (!file) return null;
        const bytes = await sources.read(file.path, file.digest);
        const revision = snapshot.temporalProvenanceGraph.nodes.find(item => item.kind === "FileRevision" && item.path === file.path && item.digest === file.digest);
        // Same bytes may occur under different parent-bound canonical IDs.
        // Keep this exact snapshot's ID on a copy, never in the byte cache.
        return bytes.text !== undefined ? { ...bytes, revisionId: revision?.nodeId || null } : bytes;
      };
      const a = await bindVersion(before, oldFile), b = await bindVersion(after, newFile);
      const comparison = compareExactSourceVersions(a?.text !== undefined ? a : null, b?.text !== undefined ? b : null, project.projectId);
      comparisons.push({ ...comparison, scope: "recorded-changeset-snapshot-pair", changeSet: reference(node), recordedRevisionChanges: recorded,
        snapshotLookup: Object.fromEntries([["before", document.before, before], ["after", document.after, after]].map(([side, endpoint, resolved]) => [side, {
          requested: endpoint, resolvedWorldModelId: resolved?.worldModelId || null,
          method: endpoint.worldModelId ? "recorded-exact-world-id" : "bounded-source-graph-pair-lookup", worldIdRecorded: Boolean(endpoint.worldModelId),
        }])),
        recordedResultPacketId: document.resultPacketId, recordedReviewDecisionId: document.reviewDecisionId,
        currentMatchesRecordedAfter: b?.digest && current.digest ? current.digest === b.digest : null,
        attribution: "Recorded ChangeSet association is not proof that this Run caused every byte change.",
        gaps: [a, b].filter(version => version?.status === "unavailable") });
      if (a?.digest && b?.digest) compared.add(JSON.stringify([a.digest, b.digest]));
    }
    for (const { ref } of [...citations, ...references]) {
      if (!validDigest(ref.digest) || current.text === undefined && current.reasonCode !== "ENOENT"
        || compared.has(JSON.stringify([ref.digest, current.digest]))) continue;
      const previous = await sources.read(relative, ref.digest), pair = JSON.stringify([ref.digest, current.digest]); compared.add(pair);
      const retainedOriginal = current.text === undefined && previous.text !== undefined ? (() => {
        const lines = previous.text.split("\n"), selected = lines.slice(0, 160).join("\n"), text = selected.slice(0, 32 * 1024);
        const includedLines = text.split("\n").length;
        return { path: relative, digest: previous.digest, basis: previous.basis, startLine: 1, endLine: includedLines,
          text, omittedLines: Math.max(0, lines.length - includedLines), textTruncated: selected.length > 32 * 1024,
          interpretation: "Exact cited historical bytes; no current after-version, deletion cause or rename continuity established." };
      })() : null;
      comparisons.push({ ...compareExactSourceVersions(previous.text !== undefined ? previous : null, current.text !== undefined ? current : null, project.projectId), scope: "cited-revision-versus-observed-current-bytes",
        ...(retainedOriginal ? { retainedOriginal } : {}),
        citedReference: ref, gaps: [previous, current].filter(version => version.status === "unavailable"), ...(previous.status === "unavailable" ? { gap: previous } : {}) });
    }
    // Explicit work-chain links can expose two cited source versions even
    // without a Run/World. The link does NOT assign request-before/fulfilled-
    // after roles to those citations; retain that uncertainty in the view.
    for (const edge of selection.edges.filter(edge => ["FOLLOWS_WORK_EVIDENCE", "DECLARES_WORK_ROOT"].includes(edge.type))) {
      for (const left of citations.filter(item => item.node.nodeId === edge.to)) for (const right of citations.filter(item => item.node.nodeId === edge.from)) {
        if (left.ref.digest === right.ref.digest) continue;
        const key = "work-chain:" + JSON.stringify([left.ref.digest, right.ref.digest]); if (compared.has(key)) continue; compared.add(key);
        const a = await sources.read(relative, left.ref.digest), b = await sources.read(relative, right.ref.digest);
        comparisons.push({ ...compareExactSourceVersions(a.text !== undefined ? a : null, b.text !== undefined ? b : null, project.projectId),
          scope: "explicit-work-chain-citation-pair-not-request-boundary", leftRecord: reference(left.node), rightRecord: reference(right.node),
          labels: { before: "Cited version A", after: "Cited version B — not necessarily current" }, timeOrder: "request-specific-source-boundaries-not-established",
          currentMatchesRecordedAfter: b.digest && current.digest ? current.digest === b.digest : null, gaps: [a, b].filter(version => version.status === "unavailable") });
      }
    }
    files.push({ path: relative, current: current.text !== undefined ? { digest: current.digest, basis: current.basis } : current,
      ...(current.text === undefined ? { currentObservation: {
        status: current.reasonCode === "ENOENT" ? "current-path-not-found" : "current-source-unavailable",
        reasonCode: current.reasonCode,
        explanation: current.reasonCode === "ENOENT"
          ? "The cited path was not found in this current source read. This does not establish deletion, rename, when it happened or why. Retained citations and recorded snapshot pairs remain separate evidence."
          : "Current source bytes are unavailable. This is not proof of deletion, rename or unchanged content; consult the exact reason and retained evidence.",
        deletionEstablished: false, renameEstablished: false,
      } } : {}),
      associations, comparisons, recordedReasonScope: "Reasons belong to cited work/reviews, not automatically to this file or each symbol.",
      unrecordedIntervals: comparisons.length ? "Other unsaved changes and missing work remain unknown." : "No exact recorded before/after source pair was selected; continue from current source and available originals." });
  }
  // Optional candidate lookup follows all primary cited-byte reads. Running
  // out of the existing Git budget cannot steal a later source comparison.
  for (const file of files) if (file.currentObservation?.reasonCode === "ENOENT") {
    const cited = file.comparisons.find(pair => pair.retainedOriginal)?.retainedOriginal;
    if (cited) file.renameEvidence = await sources.renameCandidates(file.path, cited.digest);
  }
  for (const review of relevantReviews) {
    const beforeId = review.previousProductModelId || review.baseProductModelId, afterId = review.resultingProductModelId;
    const getModel = id => {
      const node = selection.nodes.find(candidate => candidate.kind === "ProductModelRevision" && candidate.nodeId === id);
      const doc = node && original(node); return doc ? { node, model: doc.document || doc } : null;
    };
    const before = getModel(beforeId), after = getModel(afterId), delta = [];
    if (before && after) for (const field of ["featureGroups", "capabilities", "features", "requirements", "constraints", "decisions", "policies"]) {
      const a = new Map((before.model[field] || []).map(entity => [entity.key, entity])), b = new Map((after.model[field] || []).map(entity => [entity.key, entity]));
      for (const key of new Set([...a.keys(), ...b.keys()])) if (canonicalGraphJson(a.get(key) || null) !== canonicalGraphJson(b.get(key) || null)) delta.push({ field, key, before: a.get(key) || null, after: b.get(key) || null });
    }
    canonChanges.push({ review: reference(review), rationale: review.rationale || null, before: before ? reference(before.node) : { productModelId: beforeId, status: "unavailable" },
      after: after ? reference(after.node) : { productModelId: afterId, status: "unavailable" }, status: before && after ? "exact-recorded-model-delta" : "exact-canon-pair-not-selected-or-unavailable",
      changes: delta.slice(0, selection.query.maxNodes), omittedChangeCount: Math.max(0, delta.length - selection.query.maxNodes), authority: "historical-review-evidence-not-current-effect-permission" });
  }
  const events = eventNodes.map(node => ({ ...reference(node),
    sourceRole: node.workContent ? "HEAD-authored-P3-work-evidence-not-user-transcript" : node.kind === "ProjectDirection" ? "caller-conveyed-user-direction-not-transcript-capture" : "recorded-original-not-inferred-user-utterance",
    title: String(node.workContent?.summary || node.directionEvidence?.goal || node.rationale || node.planDelta || node.kind).slice(0, 360),
    titlePartial: String(node.workContent?.summary || node.directionEvidence?.goal || node.rationale || node.planDelta || node.kind).length > 360,
    contentPartial: Boolean(node.contentPartial || node.directionContentCoverage?.partial),
    cancelledActions: node.directionEvidence?.cancelledActions || [], pending: node.workContent?.pending || [], unknowns: node.workContent?.unknowns || node.unknowns || [],
    connections: selection.edges.filter(edge => edge.from === node.nodeId || edge.to === node.nodeId).map(edge => ({ edgeId: edge.edgeId, from: edge.from, to: edge.to, relation: edge.type,
      interpretation: /CITES|REFERS|OBSERVES/.test(edge.type) ? "explicit-reference-or-observation-not-fulfillment-or-cause" : "recorded-relationship-not-independently-proven-causality" })),
    missingLink: !selection.edges.some(edge => edge.from === node.nodeId || edge.to === node.nodeId) ? "No explicit connection selected; execution and outcome are unknown." : null }));
  const documentNavigation = documentSources.size ? await readContextDocumentLinks({ root, projectId: project.projectId, sources, documents: [...documentSources.values()] }) : null;
  const payload = { projectId: project.projectId, status: "partial-recorded-context", events, files, recordedReasons, canonChanges, gaps,
    ...(documentNavigation ? { documentNavigation } : {}),
    coverage: { requestedPaths: requested.length, includedPaths: files.length, omittedPaths: requested.slice(files.length), missingRecordsProveAbsence: false,
      precision: "Exact file bytes and independent bounded declaration ranges; no behavior equivalence or inferred historical reason." },
    sourceReads: sources.diagnostics(), authority: { plane: "P4-derived-view", persisted: false, recoveryAuthority: false, promotionAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false } };
  return { ...payload, explanationDigest: projectGraphDigest(payload) };
}
