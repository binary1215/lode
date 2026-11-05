import path from "node:path";
import { projectDocumentStore, documentFailure } from "./work-document-store.mjs";
import { workDocumentHash } from "./work-document-source.mjs";
import { readProductModelCanon } from "./product-model.mjs";
import { readProjectDirection } from "./project-direction.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { safeSessionPath, withSessionRoute } from "./session-routing.mjs";
import { readSessionWorkContext } from "./session-work-context.mjs";

export const PROJECT_DOCUMENT_RENDERER = "1";
const fields = { FeatureGroup: "featureGroups", Feature: "features", Decision: "decisions", Requirement: "requirements",
  Constraint: "constraints", Capability: "capabilities", Policy: "policies" };
const names = { FeatureGroup: "기능그룹", Feature: "기능", Decision: "결정", Requirement: "요구", Constraint: "제약",
  Capability: "역량", Policy: "정책", Work: "작업 기록", Session: "세션별 작업" };
const order = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const text = value => String(value).replace(/[\r\n<>]/g, " ").replace(/([\\`*_[\]#!|])/g, "\\$1");
const quote = value => String(value).replace(/\r\n?/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/([\\`*_[\]#!|])/g, "\\$1").split("\n").map(line => `> ${line}`).join("\n");
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
  const model = canon.model, nodes = [], nodeIndex = new Map(), sources = {};
  const id = (kind, key) => projectDocumentNodeId(owner.projectId, kind, key);
  const rootId = id("product-view", "project"), workIndexId = id("work-index", "work"), unclassifiedId = id("unclassified", "unclassified");
  const title = projectTitle?.trim() || path.basename(owner.root);
  if (!title || title.length > 300) documentFailure("Select a readable Project title.");
  const canonSource = { kind: "ProductModelRevision", path: canon.relativePath, digest: canon.sourceDigest,
    productModelId: model.productModelId, productModelHash: model.productModelHash, status: canon.status };
  if (canon.status === "present") sources.canon = canonSource;
  const make = (kind, key, label, data, sourceKeys = []) => {
    const node = { id: id(kind, key), kind, key, title: label, data, sourceKeys, parents: [], children: [], related: [] };
    nodes.push(node); nodeIndex.set(node.id, node); return node;
  };
  const product = make("product-view", "project", title, { canonStatus: canon.status }, canon.status === "present" ? ["canon"] : []);
  const workIndex = make("work-index", "work", "작업과 세션", {}), unclassified = make("unclassified", "unclassified", "소속 미확인", {});
  const entities = new Map();
  for (const [kind, field] of Object.entries(fields)) for (const entity of model[field] || []) {
    const sourceKey = `${kind}:${entity.key}`;
    sources[sourceKey] = { ...canonSource, entityKind: kind, entityKey: entity.key, entityDigest: workDocumentHash(entity) };
    const node = make(kind, entity.key, entity.name || entity.statement, entity, [sourceKey]);
    entities.set(sourceKey, node);
  }
  const feature = key => entities.get(`Feature:${key}`), group = key => entities.get(`FeatureGroup:${key}`);
  for (const entity of model.featureGroups) {
    const node = group(entity.key);
    node.parents = entity.parentFeatureGroupKeys.map(key => group(key).id);
    for (const parent of node.parents) nodeIndex.get(parent).children.push(node.id);
    if (!node.parents.length) product.children.push(node.id);
  }
  for (const entity of model.features) {
    const node = feature(entity.key);
    node.parents = entity.featureGroupKeys.map(key => group(key).id);
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
  for (const policy of model.policies || []) for (const ref of policy.appliesTo) {
    const from = entities.get(`Policy:${policy.key}`), to = entities.get(`${ref.kind}:${ref.key}`);
    from.related.push({ id: to.id, relation: "canonical-applies-to" });
    to.related.push({ id: from.id, relation: "canonical-policy" });
  }
  // Ungrouped governed originals remain discoverable without inventing a group.
  for (const node of entities.values()) if (!["FeatureGroup", "Feature"].includes(node.kind)) product.related.push({ id: node.id, relation: "canonical-original" });
  const sessions = new Map(), selectedWork = new Map();
  for (const ref of workEvidence) {
    if (!ref?.sessionId || !/^work-evidence-[a-f0-9]{24}$/.test(ref.evidenceId || "") || !/^[a-f0-9]{64}$/.test(ref.evidenceDigest || "")
      || !Array.isArray(ref.featureKeys || []) || (ref.featureKeys || []).some(key => typeof key !== "string")) documentFailure("Select exact Project work original references.");
    const encoded = `${ref.sessionId}/${ref.evidenceId}`;
    const prior = selectedWork.get(encoded);
    if (prior && prior.evidenceDigest !== ref.evidenceDigest) documentFailure("One work original has conflicting source digests.", "WORK_DOCUMENT_ORIGINAL_IDENTITY_MISMATCH");
    selectedWork.set(encoded, { ...ref, featureKeys: [...new Set([...(prior?.featureKeys || []), ...(ref.featureKeys || [])])] });
  }
  for (const [encoded, ref] of selectedWork) {
    const result = withSessionRoute(owner.root, ref.sessionId, () => readSessionWorkContext({ root: owner.root,
      evidenceIds: [ref.evidenceId], expectedSessionId: ref.sessionId, maxRecords: 1, maxCharacters: 524288 }));
    const record = result.records[0];
    if (!record || record.projectId !== owner.projectId || record.evidenceDigest !== ref.evidenceDigest) {
      const reason = result.unavailable?.[0]?.reasonCode || "WORK_DOCUMENT_ORIGINAL_IDENTITY_MISMATCH";
      throw Object.assign(new Error("Selected work original could not be verified."), { code: "WORK_DOCUMENT_ORIGINAL_UNAVAILABLE", primaryReasonCode: reason,
        originalFailures: result.unavailable || [] });
    }
    const sourceKey = `work:${encoded}`;
    sources[sourceKey] = { kind: "SessionWorkEvidence", projectId: owner.projectId, sessionId: ref.sessionId,
      evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest, recordedAt: record.recordedAt };
    const node = make("Work", encoded, record.content.summary || "작업 기록", { content: record.content,
      references: record.references || [], attribution: "HEAD-authored-evidence-not-original-user-approval",
      unresolvedFeatureKeys: (ref.featureKeys || []).filter(key => !feature(key)) }, [sourceKey]);
    for (const key of [...new Set(ref.featureKeys || [])]) if (feature(key)) {
      node.related.push({ id: feature(key).id, relation: "HEAD-reading-link-not-canonical-membership" });
      feature(key).related.push({ id: node.id, relation: "HEAD-reading-link-not-canonical-membership" });
    }
    if (!node.related.length || node.data.unresolvedFeatureKeys.length) unclassified.children.push(node.id);
    let session = sessions.get(ref.sessionId);
    if (!session) {
      session = make("Session", ref.sessionId, `작업 세션 · ${ref.sessionId.slice(-8)}`, {});
      sessions.set(ref.sessionId, session); workIndex.children.push(session.id);
    }
    session.children.push(node.id); node.parents.push(session.id);
    for (const link of node.related) if (!session.related.some(item => item.id === link.id)) session.related.push({ ...link });
  }
  for (const proposal of narratives) {
    const node = nodes.find(item => item.kind === proposal?.kind && item.key === proposal?.key);
    // Preserve a retained explanation's original sources across Canon changes.
    if (!node && proposal.sourceBindings) continue;
    if (!node || !Array.isArray(proposal.sourceKeys) || !proposal.sourceKeys.length || proposal.sourceKeys.some(key => !sources[key] && !proposal.sourceBindings?.[key])) documentFailure("Narrative needs a known reading node and exact available source references.", "PROJECT_DOCUMENT_NARRATIVE_SOURCE_UNKNOWN");
    const allowed = ["kind", "key", "sourceKeys", "purpose", "useFlow", "currentBehavior", "notes", "sourceBindings"];
    if (Object.keys(proposal).some(key => !allowed.includes(key)) || ["purpose", "useFlow", "currentBehavior", "notes"].some(key => proposal[key] != null && typeof proposal[key] !== "string")) documentFailure("Invalid HEAD reading narrative.");
    if (node.narrative) documentFailure("Duplicate reading narrative.");
    const sourceKeys = proposal.sourceKeys.map(key => {
      const frozen = proposal.sourceBindings?.[key];
      if (!frozen) return key;
      const exact = "narrative:" + workDocumentHash([node.id,key,frozen]);
      sources[exact] = frozen; return exact;
    });
    node.narrative = { ...proposal, sourceKeys,
      historical: Boolean(proposal.sourceBindings && proposal.sourceKeys.some(key => workDocumentHash(proposal.sourceBindings[key]) !== workDocumentHash(sources[key] || null))),
      attribution: "HEAD-reading-explanation-not-product-canon-or-runtime-verification" };
  }
  const commonDirection = withSessionRoute(owner.root, owner.sessionId, () => readProjectDirection({ root: owner.root, storage: owner.storage }));
  const payload = { kind: "ProjectDocumentHierarchyBasis", authorityPlane: "P4", renderer: PROJECT_DOCUMENT_RENDERER,
    projectId: owner.projectId, title, productCanon: canonSource, nodes: nodes.sort(order), sources, commonDirection,
    rootId, workIndexId, unclassifiedId,
    coverage: { scope: "current-canon-and-explicit-selected-work-originals", semanticSufficiency: "HEAD-judgment-required",
      sourceMissingIsNotCorruption: true, sessionDirectionMerged: false },
    authority: { instructionAuthority: false, recoveryAuthority: false, promotionAuthority: false, completionAuthority: false } };
  return { ...payload, basisId: workDocumentHash(payload), selection: { sessionId: owner.sessionId, projectTitle, workEvidence, narratives } };
}

export function renderProjectDocumentPage(basis, { nodeId, audience = "human", resolveLink, publicationStateUrl } = {}) {
  const node = basis.nodes.find(item => item.id === nodeId);
  if (!node || !["human", "agent"].includes(audience)) documentFailure("Select a known reading page and audience.");
  const byId = new Map(basis.nodes.map(item => [item.id, item]));
  const link = (id, label, otherAudience = audience) => `[${text(label || byId.get(id)?.title || id)}](${resolveLink ? resolveLink(id, otherAudience) : `lode-doc:${otherAudience}:${id}`})`;
  const lines = [`# ${text(node.title)}`];
  if (publicationStateUrl) lines.push("[프로젝트 게시 상태]("+publicationStateUrl+") · 문서끼리 갱신 시점이 다를 수 있습니다. 이 페이지는 아래에 인용한 원문 기준입니다.");
  if (audience === "agent") lines.push("근거 읽기 뷰(P4). Source, membership and work-reading association are distinct; this page is not P2 direction or approval.");
  if (node.kind === "product-view") lines.push(basis.productCanon.status === "present" ? "제품 구성과 관련 작업을 아래에서 찾아볼 수 있습니다."
    : "제품 설명 원문이 아직 없습니다. 선택한 작업 기록은 소속 미확인 목록에서 읽을 수 있습니다.");
  if (node.data.description || node.data.statement) lines.push(quote(node.data.description || node.data.statement));
  if (node.narrative) {
    if (node.narrative.historical) lines.push("아래 설명은 이전에 선택한 원문에 대한 것입니다. 현재 원문과 달라졌으며 현재 동작은 다시 확인해야 합니다.");
    for (const [key, label] of [["purpose", "목적"], ["useFlow", "사용 흐름"], ["currentBehavior", "현재 동작에 대한 설명"], ["notes", "제약·확인할 점"]]) if (node.narrative[key]) lines.push(`## ${label}\n\n${quote(node.narrative[key])}`);
  } else if (["Feature", "FeatureGroup"].includes(node.kind) && !node.data.description) lines.push("이 항목의 추가 설명은 아직 연결되어 있지 않습니다.");
  lines.push(`${link(basis.rootId, "제품")} · ${link(basis.workIndexId, "작업·세션")} · ${link(basis.unclassifiedId, "소속 미확인")} · ${link(node.id, audience === "human" ? "에이전트용" : "사람용", audience === "human" ? "agent" : "human")}`);
  if (node.data.status) lines.push(`원문에 기록된 상태: ${text(node.data.status)}`);
  if (node.parents.length) lines.push("## 상위 연결\n\n" + node.parents.map(id => `- ${link(id)}`).join("\n"));
  if (node.children.length) lines.push("## 구성·작업\n\n" + [...new Set(node.children)].map(id => `- ${link(id)}${byId.get(id)?.kind && names[byId.get(id).kind] ? ` · ${names[byId.get(id).kind]}` : ""}`).join("\n"));
  const relationLabel = ref => audience === "agent" ? text(ref.relation) : ref.relation.startsWith("HEAD-")
    ? "Lode가 원문을 읽을 때 참고하도록 연결한 기록"
    : ({ "canonical-governed-by": "관련 결정·요구·제약", "canonical-governs": "이 내용을 참조하는 기능",
      "canonical-capability": "관련 역량", "canonical-capability-of": "이 역량을 참조하는 기능",
      "canonical-applies-to": "정책 적용 대상", "canonical-policy": "관련 정책", "canonical-original": "제품 모델 원문",
      "exact-task-reading-original": "상세 읽기에서 선택한 작업 원문", "exact-task-reading-detail": "이 원문을 읽는 상세 비교·근거" })[ref.relation] || "관련 근거 연결 — 유형 미확인";
  if (node.related.length) lines.push("## 관련 근거\n\n" + node.related.map(ref => `- ${link(ref.id)} · ${relationLabel(ref)}`).join("\n"));
  if (node.kind === "Work") {
    const content = node.data.content;
    lines.push("원기록 시점: "+text(basis.sources[node.sourceKeys[0]].recordedAt)+" · 가장 최근 상태라고 추론하지 않습니다.");
    lines.push("## 기록된 결과\n\n" + quote(content.summary || "결과 설명 없음"));
    for (const [key, label] of [["observedWork", "관찰한 작업"], ["pending", "남은 일"], ["unknowns", "미확인·한계"], ["suggestedFollowUp", "후속 제안 — 승인 아님"]]) if (content[key]?.length) lines.push(`## ${label}\n\n${content[key].map(quote).join("\n\n")}`);
    for (const judgment of content.judgments || []) lines.push(quote(judgment.assessment), quote(judgment.reason), ...(judgment.alternatives || []).map(quote));
    for (const todo of content.todos || []) lines.push(`작성자가 기록한 상태: ${text(todo.status)}\n\n${quote(todo.task)}`, ...[todo.progress, todo.reason, todo.nextAction].filter(Boolean).map(quote));
    if (node.data.references.length) lines.push(`## ${audience === "human" ? "기록에 인용된 파일" : "파일 참조 — 함수 관계나 실행 검증으로 추론하지 않음"}\n\n` + node.data.references.map(ref => `- ${text(ref.path)} · ${ref.digest || "digest 미확인"} · ${text(ref.status || "미확인")}${ref.reasonCode ? ` / ${text(ref.reasonCode)}` : ""}`).join("\n"));
    if (node.data.unresolvedFeatureKeys.length) lines.push(`기능 소속 미확인: ${node.data.unresolvedFeatureKeys.map(text).join(", ")}`);
  }
  if (node.kind === "WorkDetail") lines.push("## 정확한 원문·변경 비교·검증 범위\n\n" + node.data.readingBody[audience]);
  if (basis.commonDirection) lines.push("## 공통 작업 조건·취소\n\n제품 설명이나 구현 완료로 추론하지 않는 현재 공통 작업 기록입니다.\n\n" + Object.entries(basis.commonDirection.input)
    .filter(([key, value]) => key !== "goal" && (Array.isArray(value) ? value.length : value))
    .map(([key, value]) => `${text(audience === "human" ? ({ constraints: "유지할 조건", decisions: "기록된 결정", cancelledActions: "취소된 행동" })[key] || key : key)}\n\n${(Array.isArray(value) ? value : [value]).map(quote).join("\n\n")}`).join("\n\n"));
  const sourceKeys = [...new Set([...node.sourceKeys, ...(node.narrative?.sourceKeys || [])])];
  if (audience === "agent") lines.push(`## 신원·출처\n\nProject: ${basis.projectId}\n\nLogical page: ${node.id}\n\nKind/key: ${node.kind} / ${node.key}\n\n` + sourceKeys.map(key => JSON.stringify({ sourceKey: key, ...basis.sources[key] })).join("\n\n"));
  else if (sourceKeys.length) lines.push("## 원문 근거\n\n" + sourceKeys.map(key => {
    const source=basis.sources[key], value=field=>text(source[field] || "미확인");
    const citation=source.kind==="WorkDocumentPair"
      ? "선택한 읽기 문서 "+value("projectionId")+" · 원문 선택 근거 "+value("sourceBasisId")
      :source.kind==="SessionWorkEvidence"? "작업 원문 "+value("evidenceId")+" · digest "+value("evidenceDigest")
      :source.kind==="ProductModelRevision"? "제품 원문 "+value("productModelId")+" · 파일 digest "+value("digest")
      :"출처 종류 "+value("kind")+" · 상세 식별 미확인";
    return "- "+text(key)+" · "+citation;
  }).join("\n"));
  lines.push("현재 읽기 문서·게시 이력·개인 메모는 서로 구분합니다. 이 내용은 마지막으로 확인한 근거의 읽기 뷰이며, 이후의 모든 변경이나 실제 서비스 동작을 보장하지 않습니다.");
  const markdown = lines.filter(Boolean).join("\n\n").trimEnd() + "\n";
  if (Buffer.byteLength(markdown) > 1024 * 1024) documentFailure("Select a bounded page body; original evidence remains available.", "WORK_DOCUMENT_VIEW_BOUND");
  return { nodeId: node.id, audience, markdown, sourceKeys, viewId: workDocumentHash([PROJECT_DOCUMENT_RENDERER, node.id, audience, markdown, sourceKeys.map(key => basis.sources[key])]) };
}
