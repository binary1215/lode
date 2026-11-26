import path from "node:path";
import { projectDocumentStore, documentFailure } from "../world/work-document-store.mjs";
import { workDocumentHash } from "../world/work-document-source.mjs";
import { readProductModelCanon } from "../world/product-model.mjs";
import { readProjectDirection } from "../session/project-direction.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { safeSessionPath, withSessionRoute } from "../session/session-routing.mjs";
import { readSessionWorkContext } from "../session/session-work-context.mjs";

export const PROJECT_DOCUMENT_RENDERER = "1";
const fields = {
  FeatureGroup: "featureGroups",
  Feature: "features",
  Decision: "decisions",
  Requirement: "requirements",
  Constraint: "constraints",
  Capability: "capabilities",
  Policy: "policies",
};
const order = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const projectDocumentNodeId = (projectId, kind, key) => workDocumentHash([projectId, kind, key]);

// Canon membership is copied from its original. Work-to-feature reading links
// and narrative are HEAD-authored P4 proposals, never new Canon or IMPLEMENTS.
export function readProjectDocumentBasis({ root, sessionId, projectTitle, workEvidence = [], narratives = [] } = {}) {
  const owner = projectDocumentStore({ root, sessionId }).caller;
  if (!Array.isArray(workEvidence) || !Array.isArray(narratives)) documentFailure("Select exact work originals and reading narratives.");
  safeSessionPath(owner.root, formatForVerifiedOwner(owner.storage).directory, "context", "product-model.json");
  // Only actual ENOENT is an absent model. JSON/schema/integrity/permission
  // failures keep their original reason and cannot become an empty hierarchy.
  const canon = readProductModelCanon({ projectRoot: owner.root, storage: owner.storage });
  const model = canon.model,
    nodes = [],
    nodeIndex = new Map(),
    sources = {};
  const id = (kind, key) => projectDocumentNodeId(owner.projectId, kind, key);
  const rootId = id("product-view", "project"),
    workIndexId = id("work-index", "work"),
    unclassifiedId = id("unclassified", "unclassified");
  const title = projectTitle?.trim() || path.basename(owner.root);
  if (!title || title.length > 300) documentFailure("Select a readable Project title.");
  const canonSource = {
    kind: "ProductModelRevision",
    path: canon.relativePath,
    digest: canon.sourceDigest,
    productModelId: model.productModelId,
    productModelHash: model.productModelHash,
    status: canon.status,
  };
  if (canon.status === "present") sources.canon = canonSource;
  const make = (kind, key, label, data, sourceKeys = []) => {
    const node = { id: id(kind, key), kind, key, title: label, data, sourceKeys, parents: [], children: [], related: [] };
    nodes.push(node);
    nodeIndex.set(node.id, node);
    return node;
  };
  const product = make("product-view", "project", title, { canonStatus: canon.status }, canon.status === "present" ? ["canon"] : []);
  const workIndex = make("work-index", "work", "작업과 세션", {}),
    unclassified = make("unclassified", "unclassified", "소속 미확인", {});
  const entities = new Map();
  for (const [kind, field] of Object.entries(fields))
    for (const entity of model[field] || []) {
      const sourceKey = `${kind}:${entity.key}`;
      sources[sourceKey] = { ...canonSource, entityKind: kind, entityKey: entity.key, entityDigest: workDocumentHash(entity) };
      const node = make(kind, entity.key, entity.name || entity.statement, entity, [sourceKey]);
      entities.set(sourceKey, node);
    }
  const feature = (key) => entities.get(`Feature:${key}`),
    group = (key) => entities.get(`FeatureGroup:${key}`);
  for (const entity of model.featureGroups) {
    const node = group(entity.key);
    node.parents = entity.parentFeatureGroupKeys.map((key) => group(key).id);
    for (const parent of node.parents) nodeIndex.get(parent).children.push(node.id);
    if (!node.parents.length) product.children.push(node.id);
  }
  for (const entity of model.features) {
    const node = feature(entity.key);
    node.parents = entity.featureGroupKeys.map((key) => group(key).id);
    for (const parent of node.parents) nodeIndex.get(parent).children.push(node.id);
    if (!node.parents.length) unclassified.children.push(node.id);
    for (const ref of entity.governedBy) {
      const target = entities.get(`${ref.kind}:${ref.key}`);
      node.related.push({ id: target.id, relation: "canonical-governed-by" });
      target.related.push({ id: node.id, relation: "canonical-governs" });
    }
    for (const key of entity.capabilityKeys) {
      const target = entities.get(`Capability:${key}`);
      node.related.push({ id: target.id, relation: "canonical-capability" });
      target.related.push({ id: node.id, relation: "canonical-capability-of" });
    }
  }
  for (const policy of model.policies || [])
    for (const ref of policy.appliesTo) {
      const from = entities.get(`Policy:${policy.key}`),
        to = entities.get(`${ref.kind}:${ref.key}`);
      from.related.push({ id: to.id, relation: "canonical-applies-to" });
      to.related.push({ id: from.id, relation: "canonical-policy" });
    }
  // Ungrouped governed originals remain discoverable without inventing a group.
  for (const node of entities.values())
    if (!["FeatureGroup", "Feature"].includes(node.kind)) product.related.push({ id: node.id, relation: "canonical-original" });
  const sessions = new Map(),
    selectedWork = new Map();
  for (const ref of workEvidence) {
    if (
      !ref?.sessionId ||
      !/^work-evidence-[a-f0-9]{24}$/.test(ref.evidenceId || "") ||
      !/^[a-f0-9]{64}$/.test(ref.evidenceDigest || "") ||
      !Array.isArray(ref.featureKeys || []) ||
      (ref.featureKeys || []).some((key) => typeof key !== "string")
    )
      documentFailure("Select exact Project work original references.");
    const encoded = `${ref.sessionId}/${ref.evidenceId}`;
    const prior = selectedWork.get(encoded);
    if (prior && prior.evidenceDigest !== ref.evidenceDigest)
      documentFailure("One work original has conflicting source digests.", "WORK_DOCUMENT_ORIGINAL_IDENTITY_MISMATCH");
    selectedWork.set(encoded, { ...ref, featureKeys: [...new Set([...(prior?.featureKeys || []), ...(ref.featureKeys || [])])] });
  }
  for (const [encoded, ref] of selectedWork) {
    const result = withSessionRoute(owner.root, ref.sessionId, () =>
      readSessionWorkContext({ root: owner.root, evidenceIds: [ref.evidenceId], expectedSessionId: ref.sessionId, maxRecords: 1, maxCharacters: 524288 }),
    );
    const record = result.records[0];
    if (!record || record.projectId !== owner.projectId || record.evidenceDigest !== ref.evidenceDigest) {
      const reason = result.unavailable?.[0]?.reasonCode || "WORK_DOCUMENT_ORIGINAL_IDENTITY_MISMATCH";
      throw Object.assign(new Error("Selected work original could not be verified."), {
        code: "WORK_DOCUMENT_ORIGINAL_UNAVAILABLE",
        primaryReasonCode: reason,
        originalFailures: result.unavailable || [],
      });
    }
    const sourceKey = `work:${encoded}`;
    sources[sourceKey] = {
      kind: "SessionWorkEvidence",
      projectId: owner.projectId,
      sessionId: ref.sessionId,
      evidenceId: record.evidenceId,
      evidenceDigest: record.evidenceDigest,
      recordedAt: record.recordedAt,
    };
    const node = make(
      "Work",
      encoded,
      record.content.summary || "작업 기록",
      {
        content: record.content,
        references: record.references || [],
        attribution: "HEAD-authored-evidence-not-original-user-approval",
        unresolvedFeatureKeys: (ref.featureKeys || []).filter((key) => !feature(key)),
      },
      [sourceKey],
    );
    for (const key of [...new Set(ref.featureKeys || [])])
      if (feature(key)) {
        node.related.push({ id: feature(key).id, relation: "HEAD-reading-link-not-canonical-membership" });
        feature(key).related.push({ id: node.id, relation: "HEAD-reading-link-not-canonical-membership" });
      }
    if (!node.related.length || node.data.unresolvedFeatureKeys.length) unclassified.children.push(node.id);
    let session = sessions.get(ref.sessionId);
    if (!session) {
      session = make("Session", ref.sessionId, `작업 세션 · ${ref.sessionId.slice(-8)}`, {});
      sessions.set(ref.sessionId, session);
      workIndex.children.push(session.id);
    }
    session.children.push(node.id);
    node.parents.push(session.id);
    for (const link of node.related) if (!session.related.some((item) => item.id === link.id)) session.related.push({ ...link });
  }
  for (const proposal of narratives) {
    const node = nodes.find((item) => item.kind === proposal?.kind && item.key === proposal?.key);
    // Preserve a retained explanation's original sources across Canon changes.
    if (!node && proposal.sourceBindings) continue;
    if (
      !node ||
      !Array.isArray(proposal.sourceKeys) ||
      !proposal.sourceKeys.length ||
      proposal.sourceKeys.some((key) => !sources[key] && !proposal.sourceBindings?.[key])
    )
      documentFailure("Narrative needs a known reading node and exact available source references.", "PROJECT_DOCUMENT_NARRATIVE_SOURCE_UNKNOWN");
    const allowed = ["kind", "key", "sourceKeys", "purpose", "useFlow", "currentBehavior", "notes", "sourceBindings"];
    if (
      Object.keys(proposal).some((key) => !allowed.includes(key)) ||
      ["purpose", "useFlow", "currentBehavior", "notes"].some((key) => proposal[key] != null && typeof proposal[key] !== "string")
    )
      documentFailure("Invalid Lode reading narrative.");
    if (node.narrative) documentFailure("Duplicate reading narrative.");
    const sourceKeys = proposal.sourceKeys.map((key) => {
      const frozen = proposal.sourceBindings?.[key];
      if (!frozen) return key;
      const exact = "narrative:" + workDocumentHash([node.id, key, frozen]);
      sources[exact] = frozen;
      return exact;
    });
    node.narrative = {
      ...proposal,
      sourceKeys,
      historical: Boolean(
        proposal.sourceBindings && proposal.sourceKeys.some((key) => workDocumentHash(proposal.sourceBindings[key]) !== workDocumentHash(sources[key] || null)),
      ),
      attribution: "HEAD-reading-explanation-not-product-canon-or-runtime-verification",
    };
  }
  const commonDirection = withSessionRoute(owner.root, owner.sessionId, () => readProjectDirection({ root: owner.root, storage: owner.storage }));
  const payload = {
    kind: "ProjectDocumentHierarchyBasis",
    authorityPlane: "P4",
    renderer: PROJECT_DOCUMENT_RENDERER,
    projectId: owner.projectId,
    title,
    productCanon: canonSource,
    nodes: nodes.sort(order),
    sources,
    commonDirection,
    rootId,
    workIndexId,
    unclassifiedId,
    coverage: {
      scope: "current-canon-and-explicit-selected-work-originals",
      semanticSufficiency: "HEAD-judgment-required",
      sourceMissingIsNotCorruption: true,
      sessionDirectionMerged: false,
    },
    authority: { instructionAuthority: false, recoveryAuthority: false, promotionAuthority: false, completionAuthority: false },
  };
  return { ...payload, basisId: workDocumentHash(payload), selection: { sessionId: owner.sessionId, projectTitle, workEvidence, narratives } };
}
