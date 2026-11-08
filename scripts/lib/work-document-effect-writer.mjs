import { documentFailure } from "./work-document-store.mjs";
import { workDocumentHash } from "./work-document-source.mjs";
import { sameDocumentText } from "./work-document-destinations.mjs";

// P5 delivery only. Shared by task and Project reading projections; this writer
// grants no publication permission or Canon/recovery authority.
export function createDocumentEffectWriter({ store, adapter, key, target, configurationDigest, prepared, previous, retryAttemptId,
  stableContainerIds = ["Start.md", "Notes.md"], recordInputs = false }) {
  if (retryAttemptId) {
    const attempt = store.read("attempts", `${retryAttemptId}.json`), outcome = store.read("outcomes", `${retryAttemptId}.json`);
    if (!attempt?.scope || attempt.scope.key !== key || attempt.scope.targetId !== target.id
      || attempt.scope.configurationDigest !== configurationDigest
      || attempt.scope.projectionId !== prepared.projectionId && !(attempt.scope.operation === "create" && stableContainerIds.includes(attempt.documentId))
      || attempt.scope.previousReceiptDigest !== workDocumentHash(previous || null) && previous?.projectionId !== prepared.projectionId
      || attempt.scope.adapterIdentity !== adapter.identity
      || !adapter.validateStoredWriteRejection?.(outcome?.rejectedWrite, attempt.scope.intent)) documentFailure("Explicit retry does not match the current rejected request.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
  }
  // A destination may define its own comparison form; otherwise text is exact.
  const form = adapter.textForm || (text => text), same = (a, b) => sameDocumentText(a, b, adapter.textForm);
  const has = (text, part) => form(text).includes(form(part)), count = (text, part) => form(text).split(form(part)).length - 1;
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
        const sameContainerRequest = kind === "create" && stableContainerIds.includes(input.documentId)
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
    store.write(["attempts", `${op.attemptId}.json`], { ...op.record, ...extra, ...(recordInputs ? { input } : {}) });
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
    if (!observed.complete || observed.warnings?.length || !same(observed.markdown, expected)) documentFailure("Document readback differs or is incomplete.", "WORK_DOCUMENT_REMOTE_DRIFT");
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
      const search = store.read("search", operationKey+".json");
      const pagedHistory = store.read("paged-search",operationKey+".json");
      const candidateFailure = async state => {
        const observations=new Map((state.observations||[]).map(value=>[value.id,value]));
        let checked=0, cursor=state.checkCursor||0;
        while(cursor<state.matches.length && checked++<12) {
          const candidate=state.matches[cursor++];
          try {
            const read=await adapter.read(candidate.id);
            observations.set(candidate.id,{id:candidate.id,observedAt:new Date().toISOString(),status:!read.complete||read.warnings?.length
              ?"incomplete-at-last-read":same(read.markdown,markdown)?"exact-body-at-last-read":"body-changed-at-last-read"});
          } catch(error) {
            observations.set(candidate.id,{id:candidate.id,observedAt:new Date().toISOString(),status:error.httpStatus===404?"not-found-at-last-read":"read-unconfirmed",
              reasonCode:error.code||"WORK_DOCUMENT_TRANSPORT_UNKNOWN",...(error.httpStatus?{httpStatus:error.httpStatus}:{})});
            if(error.code==="WORK_DOCUMENT_PERMISSION_DENIED") {
              store.write(["search",operationKey+".json"],{...state,checkCursor:cursor-1,observations:[...observations.values()]},true);
              throw Object.assign(error,{primaryReasonCode:"WORK_DOCUMENT_CREATE_UNKNOWN",candidateObservations:[...observations.values()],
                coverage:"different-time-parent-slices-not-current-global-uniqueness",automaticRetryAllowed:false,attemptId:operationKey});
            }
          }
        }
        const value={...state,checkCursor:cursor===state.matches.length?0:cursor,observations:[...observations.values()]};
        store.write(["search",operationKey+".json"],value,true);
        throw Object.assign(new Error("Paged parent observations cannot establish current uniqueness. No binding or repeated create was performed."),{
          code:"WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED",attemptId:operationKey,
          candidateObservations:value.observations,coverage:"different-time-parent-slices-not-current-global-uniqueness",
          primaryReasonCode:"WORK_DOCUMENT_CREATE_UNKNOWN",searchComplete:true,automaticRetryAllowed:false});
      };
      if(search?.complete && search.paged) return candidateFailure(search);
      const found = await adapter.find({ documentId, markdown, cursor: search?.cursor || null });
      const matches = [...new Map([...(search?.matches || []), ...found.matches].map(value=>[value.id,value])).values()];
      const paged=Boolean(pagedHistory||search?.paged||search?.cursor||found.cursor);
      if(paged) store.write(["paged-search",operationKey+".json"],{operationKey,scope:"multi-call-observations-never-auto-bound"});
      if (found.cursor) store.write(["search",operationKey+".json"],{cursor:found.cursor,matches,paged},true);
      // A later slice cannot prove that an earlier body has not changed.
      // Candidates remain observations; only an exact provider result or the
      // existing single-bounded-parent recovery may establish a binding.
      if(found.complete && paged) return candidateFailure({complete:true,paged:true,matches,checkCursor:0,observations:[]});
      if (found.complete && matches.length === 1 && !found.occupied) {
        const id = matches[0].id;
        await verify(id, markdown);
        store.write(["recovered", `${operationKey}.json`], { id, scope: "single-bounded-parent-observation-and-exact-readback-not-atomic-uniqueness-or-authorship" });
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
      if (!observed.complete || observed.warnings?.length || count(observed.markdown, oldText) !== 1) documentFailure("Managed text changed before retry.", "WORK_DOCUMENT_REMOTE_DRIFT");
      throw error;
    }
    const operationKey = op.attemptId, savedResponse = op.response;
    await terminal(operationKey, savedResponse, id);
    // A verified local replacement outcome can repair its interrupted binding
    // update; a same-title/content copy cannot supply that exact object identity.
    if (savedResponse?.objectIdentity) {
      const observed = await adapter.read(id);
      if (observed.objectIdentity !== savedResponse.objectIdentity || !has(observed.markdown, newText)) documentFailure("Published resource was replaced or edited.", "WORK_DOCUMENT_RESOURCE_REPLACED");
      store.write(bindingParts(id), { objectIdentity: savedResponse.objectIdentity }, true);
    }
    const read = await readBound(id);
    if (!read.complete || read.warnings?.length) documentFailure("Managed text cannot be read completely.");
    if (has(read.markdown, newText) && !has(read.markdown, oldText) || oldText === newText && has(read.markdown, newText)) return;
    if (count(read.markdown, oldText) !== 1) documentFailure("Managed text changed or matches ambiguously.", "WORK_DOCUMENT_REMOTE_DRIFT");
    if (op.existing) {
      documentFailure("An earlier change remains unverified; it was not replayed.", "WORK_DOCUMENT_UPDATE_UNKNOWN");
    }
    const response = await perform(op, input, input => adapter.replace(input), { id,
      oldDigest: workDocumentHash(oldText), payloadDigest: workDocumentHash(newText) });
    if (response.warnings?.length || response.pendingTask) documentFailure("Change awaits terminal result and readback.", "WORK_DOCUMENT_ASYNC_PENDING");
    if (response.objectIdentity) {
      const observed = await adapter.read(id);
      if (observed.objectIdentity !== response.objectIdentity || !has(observed.markdown, newText)) documentFailure("Local replacement readback differs.");
      store.write(bindingParts(id), { objectIdentity: response.objectIdentity }, true);
    }
  };
  const reconcileChangeBinding = async (id, oldText, newText) => {
    const input = { id, oldText, newText }, baseKey = workDocumentHash([key,id,oldText,newText]);
    let attemptId=baseKey;
    for (let count=0;count<64;count++) {
      const attempt=store.read("attempts",attemptId+".json"), outcome=store.read("outcomes",attemptId+".json");
      if (!attempt) return;
      if (attempt.scope?.key!==key || attempt.scope.operation!=="replace-exact-text" || attempt.scope.adapterIdentity!==adapter.identity
        || attempt.scope.inputDigest!==workDocumentHash(input) || attempt.id!==id) documentFailure("Change reconciliation differs.","WORK_DOCUMENT_RECORD_TAMPER");
      if (outcome?.objectIdentity) {
        const observed=await adapter.read(id);
        if (observed.objectIdentity!==outcome.objectIdentity || !has(observed.markdown, newText)) documentFailure("Known replacement was edited or replaced.","WORK_DOCUMENT_RESOURCE_REPLACED");
        store.write(bindingParts(id),{objectIdentity:outcome.objectIdentity},true);return;
      }
      if (!outcome?.rejectedWrite) return;
      attemptId=workDocumentHash([baseKey,attemptId,"explicit-rejected-write-successor"]);
    }
    documentFailure("Change history needs bounded inspection.","WORK_DOCUMENT_RETRY_HISTORY_PARTIAL");
  };
  const settleKnownChange = async (id, oldText, newText) => {
    const input={id,oldText,newText}, baseKey=workDocumentHash([key,id,oldText,newText]);
    let attemptId=baseKey;
    for(let count=0;count<64;count++) {
      const attempt=store.read("attempts",attemptId+".json"), outcome=store.read("outcomes",attemptId+".json");
      if(!attempt)return;
      if(attempt.scope?.key!==key || attempt.scope.operation!=="replace-exact-text" || attempt.scope.adapterIdentity!==adapter.identity
        || attempt.scope.inputDigest!==workDocumentHash(input) || attempt.id!==id)documentFailure("Pending change scope differs.","WORK_DOCUMENT_RECORD_TAMPER");
      if(outcome?.pendingTask)return terminal(attemptId,outcome,id);
      if(!outcome?.rejectedWrite)return;
      attemptId=workDocumentHash([baseKey,attemptId,"explicit-rejected-write-successor"]);
    }
    documentFailure("Pending history needs bounded inspection.","WORK_DOCUMENT_RETRY_HISTORY_PARTIAL");
  };
  return { create, change, verify, readBound, reconcileChangeBinding, settleKnownChange };
}
