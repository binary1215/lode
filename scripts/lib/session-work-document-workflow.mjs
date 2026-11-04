import { recordSessionWorkEvidence } from "./session-work-context.mjs";
import { workDocumentStore } from "./work-document-store.mjs";
import { prepareWorkDocuments, publishWorkDocuments, readWorkDocumentSelections } from "./work-document-publication.mjs";
import { workDocumentHash } from "./work-document-source.mjs";

function authoredSelection(selection, record) {
  const allowed = ["title", "evidenceIds", "related", "diffs", "excerpts", "graphAnchors"];
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection).some(key => !allowed.includes(key))) throw Object.assign(new Error("Invalid HEAD document selection."), { code: "WORK_DOCUMENT_SELECTION_INVALID" });
  const id = value => value === "recorded" ? record.evidenceId : value;
  const source = value => ({ ...value, evidenceId: id(value.evidenceId) });
  const evidenceIds = (selection.evidenceIds || ["recorded"]).map(id);
  if (!evidenceIds.includes(record.evidenceId)) throw Object.assign(new Error("The selected result must be included."), { code: "WORK_DOCUMENT_RECORDED_RESULT_NOT_SELECTED" });
  return { ...selection, evidenceIds, diffs: (selection.diffs || []).map(pair => ({ before: source(pair.before), after: source(pair.after) })),
    excerpts: (selection.excerpts || []).map(source) };
}
const rich = selection => selection && (selection.evidenceIds.length > 1 || ["related", "diffs", "excerpts", "graphAnchors"].some(key => selection[key]?.length));
const exact = (a, b) => a?.evidenceId === b?.evidenceId && a?.evidenceDigest === b?.evidenceDigest;

// Preserve the synchronous create-only P3 writer. Only public async composition
// attaches optional effects, after that original has been saved successfully.
export async function recordSessionWorkAndProjectDocuments({ root, input, documentSelection, documentSelectionError, adapters } = {}) {
  const result = recordSessionWorkEvidence({ root, input });
  let documentProjection;
  try {
    if (documentSelectionError) throw Object.assign(new Error("The optional HEAD document selection could not be read."), { code: documentSelectionError });
    const record = result.evidence, store = workDocumentStore({ root, sessionId: record.sessionId });
    const targets = store.read("configuration.json")?.targets || [];
    const todo = record.content.todos?.length === 1 ? record.content.todos[0] : null;
    const chosen = todo ? targets.filter(target => target.automatic && target.todoIds.includes(todo.todoId)) : [];
    if (!targets.length) documentProjection = { status: "unconnected", externalEffects: 0 };
    else if (!todo) documentProjection = { status: "manual-exact-document-available", externalEffects: 0,
      reason: "No unique task result scope; existing work does not require Todos." };
    else if (!chosen.length) documentProjection = { status: "outside-automatic-scope", externalEffects: 0 };
    else if (todo.status === "pending" && !todo.prior && !record.content.observedWork.length) documentProjection = { status: "no-confirmed-result-change", externalEffects: 0 };
    else {
      const logicalKey = workDocumentHash([record.projectId, record.sessionId, todo.todoId, "work-document"]);
      const prior = readWorkDocumentSelections({ root, sessionId: record.sessionId, logicalKey, targetIds: chosen.map(target => target.id) });
      const published = [...new Map(prior.published.map(item => [item.projectionId, item])).values()];
      let selection, title = todo.task.slice(0, 160);
      if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
      if (title.length < todo.task.length) title += "…";
      if (documentSelection !== undefined) {
        selection = authoredSelection(documentSelection, record); title = selection.title || title;
      } else {
        const matches = published.filter(item => exact(item.taskRevision, record));
        if (matches.length === 1) {
          selection = matches[0].sourceSelection; title = matches[0].title;
        } else if (!published.length && exact(prior.draft?.taskRevision, record)) {
          selection = prior.draft.sourceSelection; title = prior.draft.title;
        } else if (published.length > 1 || published.some(item => rich(item.sourceSelection)) || rich(prior.draft?.sourceSelection)) {
          documentProjection = { status: "head-selection-required", headActionRequired: true, userActionRequired: false,
            savedTaskStatus: todo.status, taskStatusReason: todo.reason || todo.progress || null,
            remoteDocumentState: "previous-published-basis-not-updated", externalEffects: 0,
            reason: "Keep or deliberately revise the existing exact evidence/diff/quote/related/graph scope; old after bytes are not the new change.",
            followUp: { action: "prepare-and-publish-related-work-documents", root, sessionId: record.sessionId, todoId: todo.todoId, targetIds: chosen.map(target => target.id),
              recorded: { evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest },
              previousSelections: published.length ? published.map(item => ({ projectionId: item.projectionId, title: item.title, selection: item.sourceSelection }))
                : [{ projectionId: prior.draft.projectionId, title: prior.draft.title, selection: prior.draft.sourceSelection }],
              guidance: "HEAD reads the result and authors explicit selection, then uses work-document-prepare and publish. No user JSON, new approval, P3 save or task-effect replay." } };
        } else selection = { evidenceIds: [record.evidenceId] };
      }
      if (selection) {
        const projection = await prepareWorkDocuments({ ...selection, root, sessionId: record.sessionId, todoId: todo.todoId, title });
        documentProjection = await publishWorkDocuments({ root, sessionId: record.sessionId, projectionId: projection.projectionId,
          targetIds: chosen.map(target => target.id), adapters });
      }
    }
  } catch (error) { documentProjection = { status: "document-update-unconfirmed", reasonCode: error.code || "WORK_DOCUMENT_UNAVAILABLE",
    ...(error.primaryReasonCode ? { primaryReasonCode: error.primaryReasonCode, originalFailures: error.originalFailures } : {}),
    originalWorkSaved: true, ordinaryWorkBlocked: false, executionReplayAllowed: false }; }
  return { ...result, documentProjection };
}
