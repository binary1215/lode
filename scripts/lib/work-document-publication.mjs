import fs from "node:fs";
import { workDocumentStore, documentFailure } from "./work-document-store.mjs";
import { withLocalMutation, withLocalMutationAsync } from "./project-mutation-lock.mjs";
import { readWorkDocumentBasis, renderWorkDocument, resolveWorkDocumentLinks, workDocumentHash } from "./work-document-source.mjs";
import { createNotionWorkDocumentAdapter, createObsidianWorkDocumentAdapter, createBoundedNotionRequest, sameDocumentText } from "./work-document-destinations.mjs";
import { readSessionWorkContext } from "./session-work-context.mjs";
import { withSessionRoute } from "./session-routing.mjs";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
const marker = key => `Lode document identity: ${key}`;
const managed = text => `Lode current links begin\n\n${text}\n\nLode current links end`;
const body = (markdown, key) => `${markdown.trimEnd()}\n\n${marker(key)}\n`;

export function configureWorkDocuments({ root, sessionId, targets, expectedConfigurationDigest = null } = {}) {
  const store = workDocumentStore({ root, sessionId });
  if (!Array.isArray(targets) || targets.length > 8 || new Set(targets.map(value => value.id)).size !== targets.length) documentFailure("Select bounded distinct destinations.");
  for (const target of targets) {
    if (!ID.test(target.id || "") || !["obsidian", "notion"].includes(target.kind)
      || !Array.isArray(target.todoIds) || target.todoIds.length > 32 || target.todoIds.some(id => !/^todo-[a-z0-9][a-z0-9-]{0,79}$/.test(id))
      || typeof target.automatic !== "boolean") documentFailure("Explicit destination and automatic task scope are required.");
    if (target.kind === "obsidian") {
      if (typeof target.vaultRoot !== "string" || !fs.lstatSync(target.vaultRoot).isDirectory() || fs.lstatSync(target.vaultRoot).isSymbolicLink()) documentFailure("Select an existing vault.");
    } else if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(target.parentPageId || "")
      || typeof target.tokenEnvironment !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(target.tokenEnvironment)) documentFailure("Select an exact Notion parent and explicit credential environment reference.");
    const allowed = ["id", "kind", "todoIds", "automatic", ...(target.kind === "obsidian" ? ["vaultRoot"] : ["parentPageId", "tokenEnvironment"])];
    if (Object.keys(target).some(key => !allowed.includes(key))) documentFailure("Unsupported destination field.");
  }
  return withLocalMutation({ directory: store.file("configuration.lock") }, () => {
    const previous = store.read("configuration.json");
    const value = { targets, configurationDigest: workDocumentHash(targets) };
    if (previous?.configurationDigest === value.configurationDigest) return { status: "reused", ...value, externalEffects: 0 };
    if ((previous?.configurationDigest || null) !== expectedConfigurationDigest) documentFailure("Connection scope changed; use the current exact configuration.", "WORK_DOCUMENT_CONFIGURATION_CHANGED");
    store.write(["configuration.json"], value, true);
    return { status: "configured", ...value, externalEffects: 0 };
  });
}

export function workDocumentStatus(options = {}) {
  const store = workDocumentStore(options), configuration = store.read("configuration.json");
  return { kind: "WorkDocumentStatusProjection", authorityPlane: "P4", projectId: store.owner.projectId, sessionId: store.owner.sessionId,
    status: configuration?.targets.length ? "configured" : "unconnected", configuration,
    ordinaryWorkBlocked: false, recoveryAuthority: false, executionReplayAllowed: false,
    ...(options.logicalKey && HEX.test(options.logicalKey) ? { destinations: (configuration?.targets || []).map(target => ({
      id: target.id, current: store.read("current", `${workDocumentHash([target.id, target.kind, target.vaultRoot || target.parentPageId, options.logicalKey])}.json`),
    })) } : {}) };
}

export async function prepareWorkDocuments(options = {}) {
  const basis = await readWorkDocumentBasis(options);
  const views = ["human", "agent"].map(audience => renderWorkDocument(basis, { audience, title: options.title }));
  const projection = { kind: "WorkDocumentPair", basis, views, projectionId: workDocumentHash([basis.basisId, views.map(view => view.viewId)]) };
  const store = workDocumentStore({ root: options.root, sessionId: basis.sessionId });
  store.write(["prepared", `${projection.projectionId}.json`], projection);
  withLocalMutation({ directory: store.file("selection-locks", `${basis.logicalKey}.lock`) }, () => store.write(
    ["selections", `${basis.logicalKey}.json`], { projectionId: projection.projectionId, logicalKey: basis.logicalKey,
      title: options.title, sourceSelection: basis.selection, taskRevision: selectedRevision(basis),
      authority: "replaceable-HEAD-reading-selection-not-direction-or-publication" }, true));
  return { status: "prepared", ...projection, publication: "not-attempted", ordinaryWorkBlocked: false };
}

export function readWorkDocumentSelections({ root, sessionId, logicalKey, targetIds }) {
  const store = workDocumentStore({ root, sessionId }), status = workDocumentStatus({ root, sessionId, logicalKey });
  return { published: status.destinations.filter(target => targetIds.includes(target.id) && target.current)
    .map(target => ({ targetId: target.id, ...target.current })), draft: store.read("selections", `${logicalKey}.json`) };
}

async function configuredAdapter(target, basis, supplied) {
  if (supplied?.[target.id]) return supplied[target.id];
  if (target.kind === "obsidian") return createObsidianWorkDocumentAdapter({ vaultRoot: target.vaultRoot,
    directory: `Lode/${basis.projectId}/${basis.sessionId}/${basis.logicalKey}` });
  // Only an explicitly connected environment reference is read, at effect time.
  const token = process.env[target.tokenEnvironment];
  if (!token) documentFailure("The configured Notion connection is unavailable.", "WORK_DOCUMENT_UNCONNECTED");
  return createNotionWorkDocumentAdapter({ parentPageId: target.parentPageId, request: createBoundedNotionRequest({ token }) });
}

function selectedRevision(basis) {
  if (basis.todoId) return basis.taskState.items.find(task => task.todoId === basis.todoId)?.revision || null;
  const records = basis.records.filter(record => record.role === "selected-task");
  const parents = new Set(records.map(record => record.content.workLink?.predecessor?.evidenceId));
  const leaves = records.filter(record => !parents.has(record.evidenceId));
  return leaves.length === 1 ? { evidenceId: leaves[0].evidenceId, evidenceDigest: leaves[0].evidenceDigest } : null;
}
function currentEligibility(basis) {
  if (!basis.taskState) return { eligible: selectedRevision(basis) !== null, scope: "explicit-manual-original-not-task-completion",
    ...(selectedRevision(basis) ? {} : { reasonCode: "WORK_DOCUMENT_SCOPE_AMBIGUOUS" }) };
  const task = basis.taskState.items.find(item => item.todoId === basis.todoId);
  if (basis.taskState.coverage.status !== "all-current-originals-inspected" || !task || task.status === "conflict" || task.missingPriors?.length
    || !basis.records.some(record => record.role === "selected-task" && record.evidenceId === task.revision?.evidenceId && record.evidenceDigest === task.revision?.evidenceDigest)) return { eligible: false, reasonCode: "WORK_DOCUMENT_TASK_REVISION_UNCERTAIN",
      currentRecordedTask: task ? { todoId: task.todoId, status: task.status, revision: task.revision, reason: task.reason || null, nextAction: task.nextAction || null } : null,
      remoteDocumentState: "previous-published-basis-not-updated" };
  if (task.status === "completed") {
    const record = basis.records.find(value => value.evidenceId === task.revision.evidenceId);
    // This checks that a result body was supplied, never whether its prose is
    // semantically sufficient, true, tested or approved. The view stays an
    // attributed report; a pure analysis needs no artificial file attachment.
    if (!record.content.summary && !record.content.observedWork.length && !record.content.judgments.length) return {
      eligible: false, reasonCode: "WORK_DOCUMENT_RESULT_EVIDENCE_MISSING", resultClaimOnly: true };
  }
  return { eligible: true, taskStatus: task.status, completionAuthority: false };
}

async function advances(root, basis, previous) {
  if (!previous || previous.basisId === basis.basisId) return true;
  const target = previous.taskRevision;
  if (!target) return false;
  const records = new Map(basis.records.filter(record => record.role === "selected-task").map(record => [record.evidenceId, record]));
  const selected = selectedRevision(basis), start = records.get(selected?.evidenceId);
  if (!start) return false;
  const queue = [start], seen = new Set();
  while (queue.length && seen.size < 64) {
    const record = queue.shift();
    if (seen.has(record.evidenceId)) continue;
    seen.add(record.evidenceId);
    if (record.evidenceId === target.evidenceId && record.evidenceDigest === target.evidenceDigest) return true;
    const task = record.content.todos?.find(item => item.todoId === basis.todoId);
    const refs = basis.todoId ? [task?.prior, ...(task?.resolves || [])].filter(Boolean) : [record.content.workLink?.predecessor].filter(Boolean);
    for (const ref of refs) {
      let original = records.get(ref.evidenceId);
      if (!original) {
        const read = withSessionRoute(root, basis.sessionId, () => readSessionWorkContext({ root,
          evidenceIds: [ref.evidenceId], expectedSessionId: basis.sessionId, maxRecords: 1, maxCharacters: 524288 }));
        original = read.records[0];
      }
      if (!original || original.evidenceDigest !== ref.evidenceDigest) return false;
      queue.push(original);
    }
  }
  return false;
}

export async function publishWorkDocuments({ root, sessionId, projectionId, targetIds, adapters, retryRejectedWrites = [] } = {}) {
  if (!HEX.test(projectionId || "") || !Array.isArray(targetIds) || !targetIds.length || targetIds.length > 8 || new Set(targetIds).size !== targetIds.length) documentFailure("Select a prepared pair and destinations.");
  if (!Array.isArray(retryRejectedWrites) || retryRejectedWrites.length > 8 || retryRejectedWrites.some(ref => !targetIds.includes(ref?.targetId)
    || !HEX.test(ref?.attemptId || "") || Object.keys(ref).some(key => !["targetId", "attemptId"].includes(key)))
    || new Set(retryRejectedWrites.map(ref => ref.targetId)).size !== retryRejectedWrites.length) documentFailure("Select exact rejected attempts for explicit retry.");
  const store = workDocumentStore({ root, sessionId });
  const prepared = store.read("prepared", `${projectionId}.json`);
  if (!prepared || prepared.projectionId !== projectionId || prepared.basis.projectId !== store.owner.projectId || prepared.basis.sessionId !== store.owner.sessionId) documentFailure("Prepared document owner differs.");
  const current = await readWorkDocumentBasis({ root, ...prepared.basis.selection });
  const regenerated = ["human", "agent"].map(audience => renderWorkDocument(current, { audience, title: prepared.views[0].title }));
  if (workDocumentHash([current.basisId, regenerated.map(view => view.viewId)]) !== projectionId
    || workDocumentHash(regenerated) !== workDocumentHash(prepared.views)) return { status: "source-basis-changed", localDocumentsAvailable: true, destinations: [], ordinaryWorkBlocked: false };
  const eligibility = currentEligibility(current);
  if (!eligibility.eligible) return { status: "document-result-unconfirmed", ...eligibility, localDocumentsAvailable: true, destinations: [], ordinaryWorkBlocked: false };
  const configuration = store.read("configuration.json");
  const results = [];
  for (const id of targetIds) {
    const target = configuration?.targets.find(value => value.id === id);
    if (!target) { results.push({ id, status: "unconnected" }); continue; }
    try {
      const adapter = await configuredAdapter(target, current, adapters);
      const key = workDocumentHash([id, target.kind, target.vaultRoot || target.parentPageId, current.logicalKey]);
      const result = await withLocalMutationAsync({ directory: store.file("locks", `${key}.lock`), timeoutMs: 0 }, () => publishPair({
        root, store, prepared, adapter, key, target, configurationDigest: configuration.configurationDigest,
        retryAttemptId: retryRejectedWrites.find(ref => ref.targetId === id)?.attemptId,
      }));
      results.push({ id, ...result });
    } catch (error) { results.push({ id, status: error.rejectedWrite ? "request-rejected-no-write" : error.code === "WORK_DOCUMENT_PERMISSION_DENIED" ? "permission-denied" : "publication-unconfirmed",
      reasonCode: error.code || "WORK_DOCUMENT_TRANSPORT_UNKNOWN", executionReplayAllowed: false,
      ...(error.rejectedWrite ? { rejectedWrite: error.rejectedWrite, retry: { targetId: id, attemptId: error.attemptId },
        retryRequires: "explicit-same-request-after-cause-repair-no-automatic-retry" } : {}),
      ...(error.rejectionRecordingFailure ? { rejectionRecordingFailure: error.rejectionRecordingFailure,
        observedServiceError: error.observedServiceError, durableRejectionAvailable: false } : {}) }); }
  }
  return { kind: "WorkDocumentPublicationOutcome", authorityPlane: "P5", status: results.every(value => value.status === "current") ? "published" : "partial-or-unconfirmed",
    projectionId, destinations: results, ordinaryWorkBlocked: false, taskEffectsReplayed: false, reviewOrCheckpointCreated: false };
}

async function publishPair({ root, store, prepared, adapter, key, target, configurationDigest, retryAttemptId }) {
  adapter.beginPublication?.();
  const { basis, views } = prepared;
  const previous = store.read("current", `${key}.json`);
  if (!await advances(root, basis, previous)) return { status: "historical-no-current-change", reasonCode: "WORK_DOCUMENT_NOT_EXPLICIT_SUCCESSOR" };
  if (retryAttemptId) {
    const attempt = store.read("attempts", `${retryAttemptId}.json`), outcome = store.read("outcomes", `${retryAttemptId}.json`);
    if (!attempt?.scope || attempt.scope.key !== key || attempt.scope.targetId !== target.id
      || attempt.scope.configurationDigest !== configurationDigest
      || attempt.scope.projectionId !== prepared.projectionId && !(attempt.scope.operation === "create" && ["Start.md", "Notes.md"].includes(attempt.documentId))
      || attempt.scope.previousReceiptDigest !== workDocumentHash(previous || null) && previous?.projectionId !== prepared.projectionId
      || attempt.scope.adapterIdentity !== adapter.identity
      || !adapter.validateStoredWriteRejection?.(outcome?.rejectedWrite, attempt.scope.intent)) documentFailure("Explicit retry does not match the current rejected request.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
  }
  const reject = (attemptId, proof) => { throw Object.assign(new Error("The exact write was rejected; explicit retry is available after its cause is repaired."), {
    code: "WORK_DOCUMENT_REQUEST_REJECTED", attemptId, rejectedWrite: proof.response }); };
  const operation = (baseKey, kind, input) => {
    const intent = adapter.writeIntent?.(kind, input) || null;
    const scope = { key, configurationDigest, projectionId: prepared.projectionId, previousReceiptDigest: workDocumentHash(previous || null),
      adapterIdentity: adapter.identity, targetId: target.id, operation: kind, inputDigest: workDocumentHash(input), intent };
    let attemptId = baseKey, priorAttemptId = null;
    for (let count = 0; count < 64; count++) {
      const existing = store.read("attempts", `${attemptId}.json`), response = store.read("outcomes", `${attemptId}.json`);
      const nextId = workDocumentHash([baseKey, attemptId, "explicit-rejected-write-successor"]);
      if (response?.rejectedWrite && store.read("attempts", `${nextId}.json`)) {
        if (existing?.baseKey !== baseKey || existing.attemptId !== attemptId || existing.priorAttemptId !== priorAttemptId
          || existing.scope?.key !== key || existing.scope.inputDigest !== scope.inputDigest || existing.scope.adapterIdentity !== adapter.identity
          || !adapter.validateStoredWriteRejection?.(response.rejectedWrite, intent)) documentFailure("Rejected-write chain differs.", "WORK_DOCUMENT_RECORD_TAMPER");
        priorAttemptId = attemptId; attemptId = nextId; continue;
      }
      if (existing?.scope && (existing.baseKey !== baseKey || existing.attemptId !== attemptId || existing.priorAttemptId !== priorAttemptId)) documentFailure("Write attempt coordinates differ.", "WORK_DOCUMENT_RECORD_TAMPER");
      if (existing?.scope && workDocumentHash(existing.scope) !== workDocumentHash(scope)) {
        const sameContainerRequest = kind === "create" && ["Start.md", "Notes.md"].includes(input.documentId)
          && existing.baseKey === baseKey && existing.attemptId === attemptId && existing.priorAttemptId === priorAttemptId
          && workDocumentHash({ ...existing.scope, projectionId: scope.projectionId }) === workDocumentHash(scope);
        // A successful old create is reusable across successor projections, but
        // no rejection authorizes different content. A stable container can
        // retain its identical request under a freshly verified prepared basis.
        if (!sameContainerRequest && (!(response?.id || store.read("recovered", `${attemptId}.json`)?.id) || response?.rejectedWrite
          || existing.scope.key !== key || existing.scope.inputDigest !== scope.inputDigest
          || existing.scope.adapterIdentity !== adapter.identity)) documentFailure("The recorded write scope changed.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
      }
      if (response?.rejectedWrite) {
        if (!existing?.scope || !adapter.validateStoredWriteRejection?.(response.rejectedWrite, intent)) documentFailure("Rejected-write evidence is not valid for this request.", "WORK_DOCUMENT_RECORD_TAMPER");
        if (retryAttemptId !== attemptId) reject(attemptId, response.rejectedWrite);
        return { attemptId: nextId, existing: null, response: null, record: { baseKey, attemptId: nextId, priorAttemptId: attemptId, scope } };
      }
      return { attemptId, existing, response, record: { baseKey, attemptId, priorAttemptId, scope } };
    }
    documentFailure("Rejected-write history needs bounded inspection.", "WORK_DOCUMENT_RETRY_HISTORY_PARTIAL");
  };
  const perform = async (op, input, effect, extra) => {
    store.write(["attempts", `${op.attemptId}.json`], { ...op.record, ...extra });
    let response;
    try { response = await effect(input); }
    catch (error) {
      const proof = adapter.describeWriteRejection?.(error, op.record.scope.intent);
      if (proof) {
        try { store.write(["outcomes", `${op.attemptId}.json`], { rejectedWrite: proof }); }
        catch (recordingError) { error.rejectionRecordingFailure = recordingError.code || "WORK_DOCUMENT_REJECTION_RECORD_UNKNOWN";
          error.observedServiceError = proof.response; throw error; }
        reject(op.attemptId, proof);
      }
      throw error;
    }
    store.write(["outcomes", `${op.attemptId}.json`], { ...response,
      ...(response.pendingTask ? { nextPollAt: Date.now() + Math.max(1, response.pollAfterSeconds || 1) * 1000 } : {}) });
    return response;
  };
  const bindingParts = id => ["bindings", `${workDocumentHash([key, id])}.json`];
  const readBound = async id => {
    const observed = await adapter.read(id), binding = store.read(...bindingParts(id));
    if (binding?.objectIdentity && observed.objectIdentity !== binding.objectIdentity) documentFailure("The old document was replaced; its reference was not rebound.", "WORK_DOCUMENT_RESOURCE_REPLACED");
    return observed;
  };
  const verify = async (id, expected) => {
    const observed = await readBound(id);
    if (!observed.complete || observed.warnings?.length || !sameDocumentText(observed.markdown, expected)) documentFailure("Document readback differs or is incomplete.", "WORK_DOCUMENT_REMOTE_DRIFT");
    return { id, ...(observed.objectIdentity ? { objectIdentity: observed.objectIdentity } : {}),
      payloadDigest: workDocumentHash(expected), readbackDigest: workDocumentHash(observed.markdown), complete: true };
  };
  const terminal = async (operationKey, response, expectedId = null) => {
    if (!response?.pendingTask) return;
    const saved = store.read("terminal", `${operationKey}.json`);
    if (saved) {
      if (saved.status !== "succeeded") documentFailure("Async operation failed; no retry or completion was inferred.", "WORK_DOCUMENT_ASYNC_FAILED");
      if (expectedId && saved.resultId?.replaceAll("-", "").toLowerCase() !== expectedId.replaceAll("-", "").toLowerCase()) documentFailure("Async result belongs to another resource.", "WORK_DOCUMENT_ASYNC_RESULT_MISMATCH");
      return saved;
    }
    const schedule = store.read("poll", `${operationKey}.json`);
    if (!adapter.poll || Date.now() < (schedule?.nextPollAt ?? response.nextPollAt ?? Infinity)) documentFailure("Async operation is pending.", "WORK_DOCUMENT_ASYNC_PENDING");
    const result = await adapter.poll(response.pendingTask);
    if (result?.id !== response.pendingTask || !["queued", "running", "retrying", "succeeded", "failed"].includes(result.status)) documentFailure("Unknown async task response.");
    if (["queued", "running", "retrying"].includes(result.status)) {
      store.write(["poll", `${operationKey}.json`], { nextPollAt: Date.now() + Math.max(1, result.poll_after_seconds || 1) * 1000 }, true);
      documentFailure("Async operation is pending.", "WORK_DOCUMENT_ASYNC_PENDING");
    }
    if (result.status === "succeeded" && (typeof result.result?.id !== "string" || !["page", "page_markdown"].includes(result.result.object)
      || expectedId && result.result.id.replaceAll("-", "").toLowerCase() !== expectedId.replaceAll("-", "").toLowerCase())) documentFailure("Async terminal result does not identify the requested resource.", "WORK_DOCUMENT_ASYNC_RESULT_MISMATCH");
    const observation = { status: result.status, taskId: result.id, ...(result.result?.id ? { resultId: result.result.id, resultType: result.result.object } : {}) };
    store.write(["terminal", `${operationKey}.json`], observation);
    if (result.status !== "succeeded") documentFailure("Async operation failed; actual effects remain unconfirmed.", "WORK_DOCUMENT_ASYNC_FAILED");
    return observation;
  };
  const create = async (role, documentId, title, markdown) => {
    const input = { documentId, title, markdown };
    const op = operation(workDocumentHash([key, role, markdown]), "create", input);
    const operationKey = op.attemptId, existing = op.existing, result = op.response;
    if (result?.id) return result.id;
    const recovered = store.read("recovered", `${operationKey}.json`);
    if (recovered?.id) return recovered.id;
    if (existing) {
      const completion = await terminal(operationKey, result);
      if (completion?.resultId) {
        await verify(completion.resultId, markdown);
        store.write(["recovered", `${operationKey}.json`], { id: completion.resultId, scope: "exact-terminal-create-result-and-content-readback" });
        return completion.resultId;
      }
      // An acknowledged/uncertain create is never issued twice, even after a
      // missing mapping, failed task, expired task or empty parent listing.
      const found = await adapter.find({ documentId, markdown });
      if (found.complete && found.matches.length === 1 && !found.occupied) {
        const id = found.matches[0].id;
        await verify(id, markdown);
        store.write(["recovered", `${operationKey}.json`], { id, scope: "unique-content-copy-under-trusted-attempt-not-original-authorship" });
        return id;
      }
      documentFailure("A previous create is unresolved; no duplicate create was attempted.", "WORK_DOCUMENT_CREATE_UNKNOWN");
    }
    const response = await perform(op, input, input => adapter.create(input), { role, documentId,
      payloadDigest: workDocumentHash(markdown), expectedContent: markdown });
    if (!response.id) documentFailure("Create accepted but not readback-verified.", "WORK_DOCUMENT_ASYNC_PENDING");
    if (response.objectIdentity) store.write(bindingParts(response.id), { objectIdentity: response.objectIdentity });
    await verify(response.id, markdown);
    return response.id;
  };
  const change = async (id, oldText, newText) => {
    const input = { id, oldText, newText };
    // Resolve a rejection only after the exact current resource is read below.
    // No POST/PATCH is issued merely by inspecting the journal.
    let op;
    try { op = operation(workDocumentHash([key, id, oldText, newText]), "replace-exact-text", input); }
    catch (error) {
      if (!error.rejectedWrite) throw error;
      const observed = await readBound(id);
      if (!observed.complete || observed.warnings?.length || observed.markdown.split(oldText).length !== 2) documentFailure("Managed text changed before retry.", "WORK_DOCUMENT_REMOTE_DRIFT");
      throw error;
    }
    const operationKey = op.attemptId, savedResponse = op.response;
    await terminal(operationKey, savedResponse, id);
    // A verified local replacement outcome can repair its interrupted binding
    // update; a same-title/content copy cannot supply that exact object identity.
    if (savedResponse?.objectIdentity) {
      const observed = await adapter.read(id);
      if (observed.objectIdentity !== savedResponse.objectIdentity || !observed.markdown.includes(newText)) documentFailure("Published resource was replaced or edited.", "WORK_DOCUMENT_RESOURCE_REPLACED");
      store.write(bindingParts(id), { objectIdentity: savedResponse.objectIdentity }, true);
    }
    const read = await readBound(id);
    if (!read.complete || read.warnings?.length) documentFailure("Managed text cannot be read completely.");
    if (read.markdown.includes(newText) && !read.markdown.includes(oldText) || oldText === newText && read.markdown.includes(newText)) return;
    if (read.markdown.indexOf(oldText) < 0 || read.markdown.indexOf(oldText) !== read.markdown.lastIndexOf(oldText)) documentFailure("Managed text changed or matches ambiguously.", "WORK_DOCUMENT_REMOTE_DRIFT");
    if (op.existing) {
      documentFailure("An earlier change remains unverified; it was not replayed.", "WORK_DOCUMENT_UPDATE_UNKNOWN");
    }
    const response = await perform(op, input, input => adapter.replace(input), { id,
      oldDigest: workDocumentHash(oldText), payloadDigest: workDocumentHash(newText) });
    if (response.warnings?.length || response.pendingTask) documentFailure("Change awaits terminal result and readback.", "WORK_DOCUMENT_ASYNC_PENDING");
    if (response.objectIdentity) {
      const observed = await adapter.read(id);
      if (observed.objectIdentity !== response.objectIdentity || !observed.markdown.includes(newText)) documentFailure("Local replacement readback differs.");
      store.write(bindingParts(id), { objectIdentity: response.objectIdentity }, true);
    }
  };
  const initial = managed("게시 확인 대기 중입니다. 작업 완료나 외부 배포 완료를 뜻하지 않습니다.");
  const startId = await create("start", "Start.md", "Lode work", body(`# Lode work\n\n${initial}`, basis.logicalKey));
  const notesId = await create("notes", "Notes.md", "Personal notes", body("# Personal notes\n\n개인 메모는 여기에 보관합니다. Lode는 이 문서를 갱신하지 않습니다.", `${basis.logicalKey}-notes`));
  const pages = [];
  for (const view of views) {
    const provisional = body(view.markdown.replace(/\[다른 읽기 뷰\][^\n]+/, "읽기 뷰 연결 준비 중입니다."), view.viewId);
    const id = await create(view.audience, `${view.audience}-${view.viewId}.md`, `${view.title} · ${view.audience}`, provisional);
    pages.push({ view, id, provisional });
  }
  const verified = [];
  for (let index = 0; index < pages.length; index++) {
    const { view, id, provisional } = pages[index];
    const resolved = resolveWorkDocumentLinks(view, { peer: adapter.url(pages[1 - index].id), start: adapter.url(startId) });
    const expected = body(resolved.markdown, view.viewId);
    await change(id, provisional.trimEnd(), expected.trimEnd());
    verified.push({ audience: view.audience, viewId: view.viewId, url: adapter.url(id), ...await verify(id, expected) });
  }
  // Recheck the exact source and user-selected destination after all async work.
  const refreshed = await readWorkDocumentBasis({ root, ...basis.selection });
  if (refreshed.basisId !== basis.basisId || store.read("configuration.json")?.configurationDigest !== configurationDigest) return {
    status: "views-verified-current-not-updated", reasonCode: "WORK_DOCUMENT_SOURCE_OR_DESTINATION_CHANGED", views: verified };
  const currentText = previous?.projectionId === prepared.projectionId ? previous.currentText : managed(`마지막으로 게시·조회 확인한 근거: ${basis.basisId}\n\n[사람용](${verified[0].url}) · [에이전트용](${verified[1].url}) · [개인 메모](${adapter.url(notesId)})\n\n${basis.taskState ? `기록된 작업 상태: ${basis.taskState.items[0].status}` : "명시적으로 선택한 작업 원문"}. 현재 미게시 변경 전체를 뜻하지 않습니다.${previous && previous.basisId !== basis.basisId ? `\n\n[이전 게시 문서](${previous.views[0].url})` : ""}`);
  const oldText = previous?.currentText || initial;
  await change(startId, oldText, currentText);
  const start = await readBound(startId);
  if (!start.complete || start.warnings?.length || start.markdown.split(currentText).length !== 2) documentFailure("Current links are not uniquely readback-verified.");
  await adapter.read(notesId); // Existence/parent only: personal notes may change.
  // A user edit to either view between link updates is not silently accepted.
  for (let index = 0; index < pages.length; index++) await verify(pages[index].id,
    body(resolveWorkDocumentLinks(pages[index].view, { peer: adapter.url(pages[1 - index].id), start: adapter.url(startId) }).markdown, pages[index].view.viewId));
  if ((await readWorkDocumentBasis({ root, ...basis.selection })).basisId !== basis.basisId) return { status: "current-observation-unknown", reasonCode: "WORK_DOCUMENT_SOURCE_CHANGED_DURING_LINK_UPDATE" };
  const receipt = { kind: "WorkDocumentPublicationReceipt", authorityPlane: "P5", basisId: basis.basisId, projectionId: prepared.projectionId,
    selectedEvidenceIds: basis.records.filter(record => record.role === "selected-task").map(record => record.evidenceId),
    logicalKey: basis.logicalKey, adapterIdentity: adapter.identity, startId, notesId, currentText, views: verified,
    taskRevision: selectedRevision(basis),
    sourceSelection: basis.selection, title: views[0].title,
    startReadbackDigest: workDocumentHash(start.markdown), readbackScope: "two-full-views-and-required-links", remoteCAS: false,
    currentMeans: "last-verified-published-basis-not-all-unpublished-changes", executionReplayAllowed: false };
  store.write(["receipts", `${workDocumentHash(receipt)}.json`], receipt);
  store.write(["current", `${key}.json`], receipt, true);
  return { status: "current", start: adapter.url(startId), basisId: basis.basisId, views: verified,
    remoteCAS: false, crossDestinationAtomicity: false, completionAuthority: false };
}
