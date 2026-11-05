import { sessionWorkPath, readSessionWorkEvidenceOriginalFile, inspectSessionWorkReference, readSessionWorkFileObservation,
  MAX_RECORD_BYTES, MAX_REFERENCE_BYTES, SESSION_WORK_MAX_CHARACTERS, sha, encoded, sameEvidence } from "./session-work-evidence-original.mjs";
import { readSessionWorkEvidenceOwner, projectExactSessionWorkRecord } from "./session-work-context.mjs";
import { relativeProjectArtifact, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { publicToolName } from "./lode-artifact-composition.mjs";

// Project-wide originals, not the current Host selection or recent-page reader.
export function projectSessionWorkLayer(inventory, { nodeFromRecord, relation, authority, id }) {
  const root = inventory.projectRoot, context = inventory.workContext;
  const nodes = [], edges = [], skipped = [], sources = [], owners = new Map(), originals = new Map();
  const getOwner = selector => {
    if (!owners.has(selector.statePath)) {
      try {
        const stateBytes = context.read(selector.statePath, MAX_REFERENCE_BYTES), state = JSON.parse(stateBytes);
        const owner = readSessionWorkEvidenceOwner({ root, sessionId: selector.sessionId || state.sessionId, storage: inventory.storage });
        if (owner.statePath !== selector.statePath || owner.workDirectory !== selector.directory || owner.projectId !== inventory.project.projectId
          || owner.state.schemaVersion !== 1 || owner.basis !== sha(Buffer.concat([context.read(relativeProjectArtifact(inventory.storage, "project.json"), MAX_REFERENCE_BYTES), stateBytes]))) {
          throw Object.assign(new Error("Work owner changed."), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
        }
        owners.set(selector.statePath, { owner });
      } catch (error) { owners.set(selector.statePath, { error }); }
    }
    const result = owners.get(selector.statePath);
    if (result.error) throw result.error;
    return result.owner;
  };
  for (const entry of inventory.entries) {
    const selector = sessionWorkPath(entry.path); if (!selector) continue;
    try {
      const owner = getOwner(selector), { record, bytes } = readSessionWorkEvidenceOriginalFile(owner, selector.evidenceId, context);
      if (sha(bytes) !== entry.sha256) throw Object.assign(new Error("Work original changed."), { code: "PROJECT_GRAPH_READ_DRIFT" });
      const origin = { layer: "sessionWork", path: entry.path, digest: entry.sha256 };
      const node = nodeFromRecord(record, origin, ["work"], { subtype: record.subtype, sessionId: owner.sessionId,
        evidenceDigest: record.evidenceDigest, workContent: record.content,
        freshness: "intact-historical-work-evidence", recordedAt: record.recordedAt, referenceEvidence: [], relationCoverage: [] });
      originals.set(record.evidenceId, { record, owner, node, origin }); nodes.push(node);
    } catch (error) { skipped.push({ path: entry.path, reasonCode: error.code || "INVALID_SESSION_WORK_EVIDENCE" }); }
  }
  // A bad unrelated current.json may exclude the generic Session layer. Keep
  // this separately verified owner rather than losing intact other work too.
  for (const { owner } of owners.values()) if (owner && [...originals.values()].some(item => item.owner === owner)) {
    const origin = { layer: "sessions", path: owner.statePath, digest: sha(context.read(owner.statePath, MAX_REFERENCE_BYTES)) };
    nodes.push(nodeFromRecord({ ...owner.state, kind: formatForVerifiedOwner(inventory.storage).kind("HeadSessionStateReference") }, origin, ["work"], {
      freshness: "current-session-record-bytes", reviewState: "session-progress-reference", revisionId: origin.digest }));
  }
  const nodeIds = new Set(nodes.map(node => node.nodeId));
  for (const item of originals.values()) {
    const { record, node, owner, origin } = item;
    edges.push(relation("RECORDED_FOR_SESSION", node.nodeId, owner.sessionId, origin));
    const endpoint = (selector, type, condition = () => true) => {
      const target = originals.get(selector.evidenceId);
      if (target && target.owner.sessionId === owner.sessionId && sameEvidence(target.record, selector) && condition(target.record)) {
        edges.push(relation(type, node.nodeId, target.node.nodeId, origin)); return true;
      }
      node.relationCoverage.push({ type, selector, status: "unverified", reasonCode: "SESSION_WORK_LINK_MISMATCH" });
      skipped.push({ path: origin.path, reasonCode: "SESSION_WORK_LINK_MISMATCH", selector }); return false;
    };
    const link = record.content.workLink;
    if (link) {
      const validRoot = endpoint(link.root, "DECLARES_WORK_ROOT");
      if (validRoot) endpoint(link.predecessor, "FOLLOWS_WORK_EVIDENCE", predecessor => sameEvidence(predecessor, link.root) || sameEvidence(predecessor.content.workLink?.root, link.root));
      else node.relationCoverage.push({ type: "FOLLOWS_WORK_EVIDENCE", selector: link.predecessor, status: "unverified", reasonCode: "SESSION_WORK_LINK_MISMATCH" });
    }
    // Independent of workLink validity; a saved qualifier is not live status.
    if (record.content.executionObservation?.target) endpoint(record.content.executionObservation.target, "SAVED_OBSERVATION_OF");
    const referenceViews = record.content.references.map(ref => inspectSessionWorkReference(owner, ref, { context }));
    for (let index = 0; index < record.content.references.length; index++) {
      const ref = record.content.references[index], view = referenceViews[index];
      let currentDigest = null, currentness = "unavailable";
      try { currentDigest = readSessionWorkFileObservation(root, ref.path, MAX_REFERENCE_BYTES, context, { preflight: false, includeBytes: false }).digest; currentness = currentDigest === ref.digest ? "current" : "changed"; }
      catch (error) { currentness = error.code === "ENOENT" ? "missing" : "unavailable"; }
      const fact = { ...ref, status: view.status, currentness, currentDigest,
        historicalContentAvailable: currentDigest === ref.digest && view.status !== "unavailable", contentReconstructed: false,
        ...(view.reasonCode ? { reasonCode: view.reasonCode } : {}) };
      node.referenceEvidence.push(fact);
      const targetId = id("source-revision-reference", { projectId: owner.projectId, path: ref.path, digest: ref.digest });
      if (!nodeIds.has(targetId)) {
        nodeIds.add(targetId);
        nodes.push({ nodeId: targetId, kind: "FileRevisionReference", path: ref.path, digest: ref.digest, revisionId: targetId,
          views: ["work", "product"], integrity: currentDigest === ref.digest ? "verified-reference" : "declared-reference",
          freshness: currentness === "current" ? "current-source-bytes" : currentness === "changed" ? "historical-source-bytes" : "unavailable",
          sourceReference: { path: ref.path, digest: ref.digest }, sourceCurrentness: { path: ref.path, retainedDigest: ref.digest, currentDigest, freshness: currentness },
          origin, historicalContentAvailable: currentDigest === ref.digest, reviewState: "observed-evidence", ...authority });
      }
      edges.push(relation("CITES_EXACT_REVISION", node.nodeId, targetId, { ...origin, reference: ref }, { referenceEvidence: fact }));
      const targetPath = ref.kind === "artifact" && sessionWorkPath(ref.path), target = targetPath && originals.get(targetPath.evidenceId);
      if (target && target.origin.path === ref.path && target.origin.digest === ref.digest && view.status !== "unavailable") {
        edges.push(relation("CITES_WORK_EVIDENCE", node.nodeId, target.node.nodeId, { ...origin, reference: ref }));
      }
      if (view.status === "unavailable") skipped.push({ path: origin.path, reference: ref, reasonCode: view.reasonCode || "SESSION_WORK_REFERENCE_UNAVAILABLE" });
    }
    const exactRecord = projectExactSessionWorkRecord(record, referenceViews), characters = JSON.stringify([exactRecord]).length;
    if (characters <= SESSION_WORK_MAX_CHARACTERS) node.originalExpansion = { tool: publicToolName("head_session_work_read"), arguments: {
      project_root: root, session_id: owner.sessionId, evidence_ids: [record.evidenceId], max_records: 1, max_characters: characters } };
    else node.originalExpansion = { supported: false, reasonCode: "SESSION_WORK_ENRICHED_READ_LIMIT", path: origin.path, requiredCharacters: characters };
  }
  return { nodes, edges, sources, skipped, reused: false };
}
