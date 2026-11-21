const text = { type: "string", minLength: 1 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const evidenceId = { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" };
const todoId = { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$" };
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const exactSource = object({ sessionId: text, evidenceId, referenceIndex: { type: "integer", minimum: 0 } }, ["evidenceId", "referenceIndex"]);
const resultEvidenceId = { anyOf: [evidenceId, { type: "string", const: "recorded" }] };
const compositionSource = object({ ...exactSource.properties, evidenceId: resultEvidenceId }, ["evidenceId", "referenceIndex"]);
export const workDocumentCompositionSchema = {
  ...object(
    {
      title: text,
      evidenceIds: { type: "array", minItems: 1, maxItems: 16, items: resultEvidenceId },
      related: {
        type: "array",
        maxItems: 16,
        items: object({ sessionId: text, evidenceId, evidenceDigest: digest }, ["sessionId", "evidenceId", "evidenceDigest"]),
      },
      diffs: { type: "array", maxItems: 8, items: object({ before: compositionSource, after: compositionSource }, ["before", "after"]) },
      excerpts: {
        type: "array",
        maxItems: 8,
        items: object({ ...compositionSource.properties, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, [
          "evidenceId",
          "referenceIndex",
          "startLine",
          "endLine",
        ]),
      },
      graphAnchors: { type: "array", maxItems: 8, items: text },
      featureKeys: {
        type: "array",
        items: text,
        description:
          "Product model feature keys this result belongs to (a feature the user named wins); the first decides the published folder. Reading associations only, never Canon membership or implementation proof.",
      },
    },
    [],
  ),
  description:
    "Optional Lode-authored exact document selection, separate from the immutable P3 evidence. The local request alias recorded denotes only this saved original and resolves after saving. No user JSON/approval form. Existing selection is preserved on exact retry; a new rich scope must be authored, never inferred from old after bytes.",
};
const target = object(
  {
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
    kind: { type: "string", enum: ["obsidian", "notion"] },
    vaultRoot: text,
    parentPageId: text,
    tokenEnvironment: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$" },
    automatic: { type: "boolean" },
    projectDocuments: {
      type: "boolean",
      description: "Explicit optional Project documentation publication scope; existing task-only connections stay task-only.",
    },
    todoIds: { type: "array", maxItems: 32, items: todoId },
  },
  ["id", "kind", "automatic", "todoIds"],
);
const definition = (suffix, description, fields, required, annotations) => ({
  name: `lode_work_document_${suffix}`,
  description,
  inputSchema: object({ project_root: text, ...fields }, ["project_root", ...required]),
  annotations,
});
export const workDocumentTools = [
  {
    name: "lode_project_document_prepare",
    description:
      "Prepare linked human/agent Project reading views from actual Product membership DAG and exact selected work originals. Lode authors feature reading links and source-linked narrative; Core does not infer Product meaning. Retains existing other-Session contributions. Canon-only and unclassified work need no Todo or onboarding. No external publication.",
    inputSchema: object(
      {
        project_root: text,
        project_title: text,
        work_evidence: {
          type: "array",
          items: object({ sessionId: text, evidenceId, evidenceDigest: digest, featureKeys: { type: "array", items: text } }, [
            "sessionId",
            "evidenceId",
            "evidenceDigest",
          ]),
        },
        readings: { type: "array", items: object({ sessionId: text, projectionId: digest }, ["sessionId", "projectionId"]) },
        narratives: {
          type: "array",
          items: object(
            {
              kind: text,
              key: text,
              sourceKeys: { type: "array", minItems: 1, items: text },
              purpose: text,
              useFlow: text,
              currentBehavior: text,
              notes: text,
            },
            ["kind", "key", "sourceKeys"],
          ),
        },
      },
      ["project_root"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lode_project_document_publish",
    description:
      "Publish the prepared Project hierarchy only to explicitly connected projectDocuments destinations. Bounded continuation is automatic Lode work, not a user form. Same actual parent/vault shares Project journals across Session aliases. Exact parent, unknown-write, readback and user edits remain protected. Returned current means last scoped observations, not remote CAS or completed work.",
    inputSchema: object(
      {
        project_root: text,
        projection_id: digest,
        target_ids: { type: "array", minItems: 1, maxItems: 8, items: text },
        retry_rejected_writes: { type: "array", maxItems: 8, items: object({ target_id: text, attempt_id: digest }, ["target_id", "attempt_id"]) },
      },
      ["project_root", "projection_id", "target_ids"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "lode_project_document_status",
    description:
      "Read Project-scoped publication receipt and continuation progress. No network access, live freshness, P2 recovery or task completion inference.",
    inputSchema: object({ project_root: text, target_ids: { type: "array", maxItems: 8, items: text } }, ["project_root"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  definition(
    "configure",
    "Connect only user-selected work-document destinations and explicit automatic task scope. Stores no credentials and performs no publication. A tokenEnvironment is an explicitly chosen Host environment reference, never ambient credential discovery. Ordinary Core work does not depend on this optional connection.",
    { targets: { type: "array", maxItems: 8, items: target }, expected_configuration_digest: { anyOf: [digest, { type: "null" }] } },
    ["targets"],
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  ),
  definition(
    "prepare",
    "Prepare human and agent Markdown from exact selected work originals and current common conditions. No Product, World, export, Run or Todo adoption required; use task_evidence_id for existing work without Todos. Lode selects evidence, related proposals and exact source pairs. Choose feature_keys from the Product model's features (a feature the user named wins); the result is published into that feature's folder, or 소속 미확인 when none fits. A completed label is not completion or approval proof. No external posting.",
    {
      title: text,
      feature_keys: {
        type: "array",
        maxItems: 16,
        items: text,
        description:
          "Keys of Product model features this result belongs to; the first one decides the folder. A key that is not a Product feature is reported and the result goes to 소속 미확인. A reading link only: never Canon membership or implementation proof.",
      },
      evidence_ids: { type: "array", minItems: 1, maxItems: 16, items: evidenceId },
      todo_id: todoId,
      task_evidence_id: evidenceId,
      related: {
        type: "array",
        maxItems: 16,
        items: object({ sessionId: text, evidenceId, evidenceDigest: digest }, ["sessionId", "evidenceId", "evidenceDigest"]),
      },
      diffs: { type: "array", maxItems: 8, items: object({ before: exactSource, after: exactSource }, ["before", "after"]) },
      excerpts: {
        type: "array",
        maxItems: 8,
        items: object({ ...exactSource.properties, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, [
          "evidenceId",
          "referenceIndex",
          "startLine",
          "endLine",
        ]),
      },
      graph_anchors: { type: "array", maxItems: 8, items: text },
    },
    ["title", "evidence_ids"],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  definition(
    "publish",
    "Publish a prepared pair as a new result document in its feature folder (and update the folder documents' lists) only to selected connected destinations. An unknown Notion outcome is settled by readback only and never created again; a vault file is settled by its exact name and text (absent: written; Lode's text: kept; other content: a person's file, reported with occupiedPath, never overwritten). Person-edited documents are reported, not overwritten. The first result of a task published in the old layout links back and edits the old Start list once. continuation-required means publish the same projection again; completed steps are kept. Rechecks source/selected task and destination scope. P5 outcome creates no ReviewDecision or P2 checkpoint. Real external publication requires the current user's chosen destination and scope.",
    {
      projection_id: digest,
      target_ids: { type: "array", minItems: 1, maxItems: 8, items: text },
      retry_rejected_writes: {
        type: "array",
        maxItems: 8,
        items: object({ target_id: text, attempt_id: digest }, ["target_id", "attempt_id"]),
        description:
          "Explicit retry of exact adapter-verified rejected attempts after their cause was repaired, within current authorization. Lode supplies returned attempt references. Never automatic, never for uncertain effects or to bypass a Host denial.",
      },
    },
    ["projection_id", "target_ids"],
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  definition(
    "status",
    "Read configured document destinations and, for an exact logical key, the last verified publication receipt. Does not make network requests or infer live remote freshness, task completion, deployment or host activity.",
    { logical_key: digest },
    [],
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
];
export async function workDocumentFromMcp(name, args) {
  if (name.startsWith("lode_project_document_")) {
    const api = await import("./project-document-publication.mjs"),
      root = args.project_root;
    if (name === "lode_project_document_prepare")
      return api.prepareProjectDocuments({
        root,
        projectTitle: args.project_title,
        workEvidence: args.work_evidence || [],
        readings: args.readings || [],
        narratives: args.narratives || [],
      });
    if (name === "lode_project_document_publish")
      return api.publishProjectDocuments({
        root,
        projectionId: args.projection_id,
        targetIds: args.target_ids,
        retryRejectedWrites: (args.retry_rejected_writes || []).map((ref) => ({ targetId: ref.target_id, attemptId: ref.attempt_id })),
      });
    if (name === "lode_project_document_status") return api.projectDocumentStatus({ root, targetIds: args.target_ids });
    throw new Error("Unknown Project document operation.");
  }
  const api = await import("./work-document-publication.mjs");
  const root = args.project_root;
  if (name === "lode_work_document_configure")
    return api.configureWorkDocuments({ root, targets: args.targets, expectedConfigurationDigest: args.expected_configuration_digest ?? null });
  if (name === "lode_work_document_prepare")
    return api.prepareWorkDocuments({
      root,
      title: args.title,
      evidenceIds: args.evidence_ids,
      todoId: args.todo_id ?? null,
      taskEvidenceId: args.task_evidence_id ?? null,
      related: args.related || [],
      diffs: args.diffs || [],
      excerpts: args.excerpts || [],
      graphAnchors: args.graph_anchors || [],
      featureKeys: args.feature_keys,
    });
  if (name === "lode_work_document_publish")
    return api.publishWorkDocuments({
      root,
      projectionId: args.projection_id,
      targetIds: args.target_ids,
      retryRejectedWrites: (args.retry_rejected_writes || []).map((ref) => ({ targetId: ref.target_id, attemptId: ref.attempt_id })),
    });
  if (name === "lode_work_document_status") return api.workDocumentStatus({ root, logicalKey: args.logical_key });
  throw new Error("Unknown document operation.");
}
