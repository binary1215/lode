const text = { type: "string", minLength: 1 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const evidenceId = { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" };
const todoId = { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$" };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const exactSource = object({ sessionId: text, evidenceId, referenceIndex: { type: "integer", minimum: 0 } }, ["evidenceId", "referenceIndex"]);
const resultEvidenceId = { anyOf: [evidenceId, { type: "string", const: "recorded" }] };
const compositionSource = object({ ...exactSource.properties, evidenceId: resultEvidenceId }, ["evidenceId", "referenceIndex"]);
export const workDocumentCompositionSchema = { ...object({
  title: text, evidenceIds: { type: "array", minItems: 1, maxItems: 16, items: resultEvidenceId },
  related: { type: "array", maxItems: 16, items: object({ sessionId: text, evidenceId, evidenceDigest: digest }, ["sessionId", "evidenceId", "evidenceDigest"]) },
  diffs: { type: "array", maxItems: 8, items: object({ before: compositionSource, after: compositionSource }, ["before", "after"]) },
  excerpts: { type: "array", maxItems: 8, items: object({ ...compositionSource.properties, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["evidenceId", "referenceIndex", "startLine", "endLine"]) },
  graphAnchors: { type: "array", maxItems: 8, items: text },
}, []), description: "Optional HEAD-authored exact document selection, separate from the immutable P3 evidence. The local request alias recorded denotes only this saved original and resolves after saving. No user JSON/approval form. Existing selection is preserved on exact retry; a new rich scope must be authored, never inferred from old after bytes." };
const target = object({ id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" }, kind: { type: "string", enum: ["obsidian", "notion"] },
  vaultRoot: text, parentPageId: text, tokenEnvironment: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$" },
  automatic: { type: "boolean" }, todoIds: { type: "array", maxItems: 32, items: todoId } }, ["id", "kind", "automatic", "todoIds"]);
const definition = (suffix, description, fields, required, annotations) => ({ name: `head_work_document_${suffix}`, description,
  inputSchema: object({ project_root: text, ...fields }, ["project_root", ...required]), annotations });
export const workDocumentTools = [
  definition("configure", "Connect only user-selected work-document destinations and explicit automatic task scope. Stores no credentials and performs no publication. A tokenEnvironment is an explicitly chosen Host environment reference, never ambient credential discovery. Ordinary Core work does not depend on this optional connection.",
    { targets: { type: "array", maxItems: 8, items: target }, expected_configuration_digest: { anyOf: [digest, { type: "null" }] } }, ["targets"],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
  definition("prepare", "Prepare human and agent Markdown from exact selected work originals and current common conditions. No Product, World, export, Run or Todo adoption required; use task_evidence_id for existing work without Todos. HEAD selects evidence, related proposals and exact source pairs. A completed label is not completion or approval proof. No external posting.",
    { title: text, evidence_ids: { type: "array", minItems: 1, maxItems: 16, items: evidenceId }, todo_id: todoId, task_evidence_id: evidenceId,
      related: { type: "array", maxItems: 16, items: object({ sessionId: text, evidenceId, evidenceDigest: digest }, ["sessionId", "evidenceId", "evidenceDigest"]) },
      diffs: { type: "array", maxItems: 8, items: object({ before: exactSource, after: exactSource }, ["before", "after"]) },
      excerpts: { type: "array", maxItems: 8, items: object({ ...exactSource.properties, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["evidenceId", "referenceIndex", "startLine", "endLine"]) },
      graph_anchors: { type: "array", maxItems: 8, items: text } }, ["title", "evidence_ids"],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  definition("publish", "Publish a prepared pair only to selected connected destinations. Distinguishes task work, local generation, destination success and current-link success. Unknown effects are readback-reconciled, never blindly created again. Rechecks source/selected task and destination scope. P5 outcome creates no ReviewDecision or P2 checkpoint. Real external publication requires the current user's chosen destination and scope.",
    { projection_id: digest, target_ids: { type: "array", minItems: 1, maxItems: 8, items: text },
      retry_rejected_writes: { type: "array", maxItems: 8, items: object({ target_id: text, attempt_id: digest }, ["target_id", "attempt_id"]),
        description: "Explicit retry of exact adapter-verified rejected attempts after their cause was repaired, within current authorization. HEAD supplies returned attempt references. Never automatic, never for uncertain effects or to bypass a Host denial." } }, ["projection_id", "target_ids"],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
  definition("status", "Read configured document destinations and, for an exact logical key, the last verified publication receipt. Does not make network requests or infer live remote freshness, task completion, deployment or host activity.",
    { logical_key: digest }, [], { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
];
export async function workDocumentFromMcp(name, args) {
  const api = await import("./work-document-publication.mjs");
  const root = args.project_root;
  if (name === "head_work_document_configure") return api.configureWorkDocuments({ root, targets: args.targets,
    expectedConfigurationDigest: args.expected_configuration_digest ?? null });
  if (name === "head_work_document_prepare") return api.prepareWorkDocuments({ root, title: args.title, evidenceIds: args.evidence_ids,
    todoId: args.todo_id ?? null, taskEvidenceId: args.task_evidence_id ?? null, related: args.related || [], diffs: args.diffs || [], excerpts: args.excerpts || [], graphAnchors: args.graph_anchors || [] });
  if (name === "head_work_document_publish") return api.publishWorkDocuments({ root, projectionId: args.projection_id, targetIds: args.target_ids,
    retryRejectedWrites: (args.retry_rejected_writes || []).map(ref => ({ targetId: ref.target_id, attemptId: ref.attempt_id })) });
  if (name === "head_work_document_status") return api.workDocumentStatus({ root, logicalKey: args.logical_key });
  throw new Error("Unknown document operation.");
}
