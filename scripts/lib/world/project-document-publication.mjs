import { projectDocumentStore, workDocumentStore, documentFailure as fail, storeDocumentValue, readDocumentValue } from "./work-document-store.mjs";
import { readProjectDocumentBasis, projectDocumentNodeId } from "../storage/project-document-hierarchy.mjs";
import { workDocumentHash as hash, readWorkDocumentBasis, renderWorkDocument } from "./work-document-source.mjs";
import { createNotionWorkDocumentAdapter, createBoundedNotionRequest, documentDestinationIdentity } from "./work-document-destinations.mjs";
import { DOCUMENT_LAYOUT_VERSION, documentTreeKey, openDocumentTree } from "./work-document-tree.mjs";
import { withLocalMutation, withLocalMutationAsync } from "../storage/project-mutation-lock.mjs";

const HEX = /^[a-f0-9]{64}$/;
const workKey = (value) => value.sessionId + "/" + value.evidenceId;
const readSelection = (store) => {
  const latest = store.read("selection.json");
  return latest ? { ...latest, selection: readDocumentValue(store, latest.valueDigest) } : null;
};
function readingOriginal(root, ref, projectId) {
  if (!ref?.sessionId || !HEX.test(ref.projectionId || "") || Object.keys(ref).some((key) => !["sessionId", "projectionId"].includes(key)))
    fail("Select an exact saved task reading.");
  const original = workDocumentStore({ root, sessionId: ref.sessionId }).read("prepared", ref.projectionId + ".json");
  if (
    !original ||
    original.basis.projectId !== projectId ||
    original.basis.sessionId !== ref.sessionId ||
    hash([original.basis.basisId, original.views.map((view) => view.viewId), ...(original.featureKeys?.length ? [original.featureKeys] : [])]) !==
      ref.projectionId
  )
    fail("Task reading owner or digest differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  return original;
}
function mergeSelection(root, previous, supplied, caller) {
  const work = new Map((previous?.workEvidence || []).map((ref) => [workKey(ref), ref]));
  for (const ref of supplied.workEvidence || []) {
    const prior = work.get(workKey(ref));
    if (prior && prior.evidenceDigest !== ref.evidenceDigest) fail("Work original digest differs.", "WORK_DOCUMENT_ORIGINAL_IDENTITY_MISMATCH");
    work.set(workKey(ref), { ...ref, featureKeys: [...new Set([...(prior?.featureKeys || []), ...(ref.featureKeys || [])])].sort() });
  }
  const readings = new Map();
  for (const ref of [...(previous?.readings || []), ...(supplied.readings || [])]) {
    const original = readingOriginal(root, ref, caller.projectId);
    readings.set(ref.sessionId + "/" + original.basis.logicalKey, ref);
  }
  const narratives = new Map((previous?.narratives || []).map((ref) => [ref.kind + "/" + ref.key, ref]));
  for (const ref of supplied.narratives || []) narratives.set(ref.kind + "/" + ref.key, structuredClone(ref));
  return {
    projectTitle: supplied.projectTitle ?? previous?.projectTitle,
    workEvidence: [...work.values()].sort((a, b) => workKey(a).localeCompare(workKey(b))),
    readings: [...readings.values()],
    narratives: [...narratives.values()],
  };
}

// Re-read the exact task selection using the existing source/diff/quote/graph
// reader. A file list is not code mapping, semantic sufficiency or execution.
async function currentBasis(root, selection, sessionId) {
  const basis = readProjectDocumentBasis({ root, ...selection, sessionId });
  const byId = new Map(basis.nodes.map((node) => [node.id, node]));
  for (const ref of selection.readings || []) {
    const original = readingOriginal(root, ref, basis.projectId);
    const source = await readWorkDocumentBasis({ root, ...original.basis.selection });
    const views = ["human", "agent"].map((audience) => renderWorkDocument(source, { audience, title: original.views[0].title }));
    const key = ref.sessionId + "/" + source.logicalKey,
      id = projectDocumentNodeId(basis.projectId, "WorkDetail", key);
    if (byId.has(id)) fail("Select one reading scope for each task.", "PROJECT_DOCUMENT_READING_CONFLICT");
    const sourceKey = "reading:" + key,
      readingBody = {};
    basis.sources[sourceKey] = {
      kind: "WorkDocumentPair",
      sessionId: ref.sessionId,
      projectionId: ref.projectionId,
      sourceBasisId: source.basisId,
      views: views.map((view) => ({ audience: view.audience, viewId: view.viewId })),
    };
    for (const view of views) readingBody[view.audience] = view.markdown;
    const node = {
      id,
      kind: "WorkDetail",
      key,
      title: original.views[0].title,
      sourceKeys: [sourceKey],
      parents: [],
      children: [],
      related: [],
      data: { readingBody },
    };
    basis.nodes.push(node);
    byId.set(id, node);
    for (const record of source.records) {
      const work = byId.get(projectDocumentNodeId(basis.projectId, "Work", record.sessionId + "/" + record.evidenceId));
      if (work) {
        node.related.push({ id: work.id, relation: "exact-task-reading-original" });
        work.related.push({ id, relation: "exact-task-reading-detail" });
      }
    }
    byId.get(basis.workIndexId).children.push(id);
  }
  basis.nodes.sort((a, b) => a.id.localeCompare(b.id));
  const { basisId: ignored, selection: oldSelection, ...payload } = basis;
  return { ...payload, basisId: hash(payload), selection };
}

export async function prepareProjectDocuments(options = {}) {
  const store = projectDocumentStore(options),
    previous = readSelection(store);
  const selection = mergeSelection(options.root, previous?.selection, options, store.caller);
  if (options.narratives?.length) {
    const originals = readProjectDocumentBasis({ root: options.root, sessionId: store.caller.sessionId, workEvidence: selection.workEvidence, narratives: [] });
    for (const proposal of options.narratives) {
      if (proposal.sourceBindings) fail("Source bindings are captured by Core, not supplied prose.");
      const retained = selection.narratives.find((item) => item.kind === proposal.kind && item.key === proposal.key);
      retained.sourceBindings = Object.fromEntries(
        proposal.sourceKeys.map((key) => {
          if (!originals.sources[key]) fail("Narrative source is unavailable.", "PROJECT_DOCUMENT_NARRATIVE_SOURCE_UNKNOWN");
          return [key, originals.sources[key]];
        }),
      );
    }
  }
  const basis = await currentBasis(options.root, selection, store.caller.sessionId);
  const projectionId = hash([basis.basisId, "readable-document-tree", DOCUMENT_LAYOUT_VERSION]);
  const selectionDigest = storeDocumentValue(store, selection);
  store.write(["prepared", projectionId + ".json"], {
    kind: "ProjectDocumentPreparation",
    projectId: basis.projectId,
    projectionId,
    basisId: basis.basisId,
    selectionDigest,
    layoutVersion: DOCUMENT_LAYOUT_VERSION,
    nodeCount: basis.nodes.length,
  });
  withLocalMutation({ directory: store.file("selection.lock") }, () => {
    if ((readSelection(store)?.valueDigest || null) !== (previous?.valueDigest || null))
      fail("Another Session contributed; prepare again to retain both selections.", "PROJECT_DOCUMENT_SELECTION_CHANGED");
    store.write(["selection.json"], { valueDigest: selectionDigest }, true);
  });
  return {
    kind: "ProjectDocumentPreparationProjection",
    authorityPlane: "P4",
    status: "prepared",
    projectionId,
    projectId: basis.projectId,
    basisId: basis.basisId,
    nodeCount: basis.nodes.length,
    layoutVersion: DOCUMENT_LAYOUT_VERSION,
    coverage: basis.coverage,
    publication: "not-attempted",
    ordinaryWorkBlocked: false,
  };
}
function loadPreparation(store, projectionId) {
  if (!HEX.test(projectionId || "")) fail("Select an exact prepared hierarchy.");
  const prepared = store.read("prepared", projectionId + ".json");
  if (
    !prepared ||
    prepared.projectId !== store.owner.projectId ||
    prepared.projectionId !== projectionId ||
    prepared.layoutVersion !== DOCUMENT_LAYOUT_VERSION ||
    hash([prepared.basisId, "readable-document-tree", DOCUMENT_LAYOUT_VERSION]) !== projectionId
  )
    fail("Preparation owner differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  return { ...prepared, selection: readDocumentValue(store, prepared.selectionDigest) };
}
export function projectDocumentStatus({ root, sessionId, targetIds } = {}) {
  const store = projectDocumentStore({ root, sessionId }),
    task = workDocumentStore({ root, sessionId: store.caller.sessionId });
  return {
    kind: "ProjectDocumentStatusProjection",
    authorityPlane: "P4",
    projectId: store.owner.projectId,
    ordinaryWorkBlocked: false,
    recoveryAuthority: false,
    liveRemoteFreshness: "not-inspected",
    destinations: (task.read("configuration.json")?.targets || [])
      .filter((target) => !targetIds || targetIds.includes(target.id))
      .map((target) => {
        const identity = documentDestinationIdentity(target),
          key = documentTreeKey(store.owner.projectId, identity);
        // A publication made before the readable layout keeps reading as
        // published in the old layout until a new one completes.
        const oldKey = hash([store.owner.projectId, identity, "project-documents-v1"]);
        const current = store.read("current", key + ".json"),
          old = store.read("current", oldKey + ".json");
        return {
          id: target.id,
          scopeEnabled: target.projectDocuments === true,
          layoutVersion: current ? DOCUMENT_LAYOUT_VERSION : old ? 1 : null,
          current: current || (old ? { ...old, layout: "old-layout", layoutVersion: 1 } : null),
          progress: store.read("progress", key + ".json") || (old ? store.read("progress", oldKey + ".json") : null),
          ...(current && old ? { oldLayout: { ...old, layout: "old-layout", layoutVersion: 1 } } : {}),
        };
      }),
  };
}
async function destination(target, supplied) {
  const identity = documentDestinationIdentity(target);
  if (supplied?.[target.id]) return { adapter: supplied[target.id], identity };
  if (target.kind === "obsidian") return { identity, adapter: { kind: "obsidian", identity: hash(["obsidian-tree", identity]) } };
  const token = process.env[target.tokenEnvironment];
  if (!token) fail("The selected connection is unavailable.", "WORK_DOCUMENT_UNCONNECTED");
  return { identity, adapter: createNotionWorkDocumentAdapter({ parentPageId: target.parentPageId, request: createBoundedNotionRequest({ token }) }) };
}
// Work originals and task readings for the 작업 기록 list. Feature links are
// Lode-authored reading links, never Canon membership.
function recordsInput(basis) {
  const byId = new Map(basis.nodes.map((node) => [node.id, node]));
  return {
    works: basis.nodes
      .filter((node) => node.kind === "Work")
      .map((node) => ({
        key: node.key,
        recordedAt: basis.sources[node.sourceKeys[0]]?.recordedAt,
        content: node.data.content,
        featureKeys: node.related.filter((ref) => ref.relation.startsWith("HEAD-") && byId.get(ref.id)?.kind === "Feature").map((ref) => byId.get(ref.id).key),
      })),
    readings: basis.nodes
      .filter((node) => node.kind === "WorkDetail")
      .map((node) => ({ logicalKey: node.key.split("/").at(-1), title: node.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export async function publishProjectDocuments({ root, sessionId, projectionId, targetIds, adapters, retryRejectedWrites = [], maxPageOperations = 3 } = {}) {
  if (
    !Array.isArray(targetIds) ||
    !targetIds.length ||
    targetIds.length > 8 ||
    new Set(targetIds).size !== targetIds.length ||
    !Number.isInteger(maxPageOperations) ||
    maxPageOperations < 1 ||
    maxPageOperations > 3 ||
    !Array.isArray(retryRejectedWrites) ||
    retryRejectedWrites.some((ref) => !targetIds.includes(ref?.targetId) || !HEX.test(ref?.attemptId || "")) ||
    new Set(retryRejectedWrites.map((ref) => ref.targetId)).size !== retryRejectedWrites.length
  )
    fail("Select bounded publication operations.");
  const store = projectDocumentStore({ root, sessionId }),
    task = workDocumentStore({ root, sessionId: store.caller.sessionId });
  const prepared = loadPreparation(store, projectionId),
    configuration = task.read("configuration.json"),
    results = [];
  for (const targetId of targetIds) {
    const target = configuration?.targets.find((item) => item.id === targetId);
    if (!target || target.projectDocuments !== true) {
      results.push({ id: targetId, status: target ? "project-scope-not-connected" : "unconnected", externalEffects: 0 });
      continue;
    }
    try {
      const { adapter, identity } = await destination(target, adapters),
        key = documentTreeKey(store.owner.projectId, identity);
      // The same lock as task results: one tree, one writer at a time.
      const result = await withLocalMutationAsync({ directory: store.file("locks", key + ".lock"), timeoutMs: 10000 }, async () => {
        const check = async () => {
          if (task.read("configuration.json")?.configurationDigest !== configuration.configurationDigest)
            fail("Destination scope changed.", "WORK_DOCUMENT_CONFIGURATION_CHANGED");
          if (readSelection(store)?.valueDigest !== prepared.selectionDigest)
            fail("New shared evidence needs merged preparation.", "PROJECT_DOCUMENT_SELECTION_CHANGED");
          const basis = await currentBasis(root, prepared.selection, store.caller.sessionId);
          if (basis.basisId !== prepared.basisId) fail("Source basis changed.", "PROJECT_DOCUMENT_SOURCE_CHANGED");
          return basis;
        };
        const basis = await check();
        adapter.beginPublication?.();
        const retryRef = retryRejectedWrites.find((ref) => ref.targetId === targetId)?.attemptId;
        if (retryRef) {
          const attempt = store.read("attempts", retryRef + ".json"),
            outcome = store.read("outcomes", retryRef + ".json");
          if (
            !attempt?.scope ||
            attempt.scope.targetId !== key ||
            !outcome?.rejectedWrite ||
            attempt.context?.configurationDigest !== configuration.configurationDigest
          )
            fail("Retry does not belong to this exact Project destination.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
        }
        const tree = openDocumentTree({
          store,
          key,
          target,
          adapter,
          permissionDigest: hash([store.owner.projectId, identity, "explicit-document-destination-scope"]),
          retryAttemptId: retryRef,
          attemptContext: { configurationDigest: configuration.configurationDigest },
          check,
        });
        const records = recordsInput(basis);
        tree.setExtras({
          narratives: new Map(basis.nodes.filter((node) => node.narrative).map((node) => [node.kind + "/" + node.key, node.narrative])),
          records: records.works.length || records.readings.length ? records : null,
        });
        const steps = tree.projectSteps({ records: records.works.length || records.readings.length });
        let state = store.read("progress", key + ".json");
        if (state?.projectionId !== projectionId) state = { projectionId, phase: "write", cursor: 0, personEdited: [] };
        const saveState = () => store.write(["progress", key + ".json"], state, true);
        // Person edits found in any call of this publication are reported at its end.
        const noteEdits = () => {
          const seen = new Set(state.personEdited.map((value) => JSON.stringify(value)));
          for (const value of tree.report.personEdited) if (!seen.has(JSON.stringify(value))) state.personEdited = [...state.personEdited, value];
        };
        let operations = 0;
        try {
          while (state.phase === "write" && state.cursor < steps.length && operations++ < maxPageOperations) {
            await tree.runProjectStep(steps[state.cursor], { multiCall: steps.length > maxPageOperations });
            state.cursor++;
            noteEdits();
            saveState();
          }
        } catch (error) {
          // The bounded Notion request budget ends this call; journaled steps continue next time.
          if (error.code !== "WORK_DOCUMENT_TRANSPORT_BUDGET" || error.rejectedWrite) throw error;
          noteEdits();
          saveState();
          return {
            status: "continuation-required",
            projectionId,
            processed: state.cursor,
            documentCount: steps.length,
            reasonCode: error.code,
            headActionRequired: true,
            userActionRequired: false,
            remoteCAS: false,
          };
        }
        if (state.phase === "write" && state.cursor === steps.length) {
          await check();
          const product = tree.folderDoc("product");
          const receipt = {
            kind: "ProjectDocumentPublicationReceipt",
            authorityPlane: "P5",
            layoutVersion: DOCUMENT_LAYOUT_VERSION,
            projectId: basis.projectId,
            projectionId,
            basisId: basis.basisId,
            destinationIdentity: identity,
            productDocument: tree.url(product),
            documents: steps.length,
            verifiedScope: "paged-last-observations-not-simultaneous-remote-CAS",
            remoteCAS: false,
            completedWorkInferred: false,
            recoveryAuthority: false,
          };
          store.write(["receipts", hash(receipt) + ".json"], receipt);
          store.write(["current", key + ".json"], receipt, true);
          state = { ...state, phase: "complete" };
          saveState();
          return { status: "current", ...receipt, ...(state.personEdited.length ? { personEdited: state.personEdited } : {}) };
        }
        if (state.phase === "complete") return { status: "current", ...store.read("current", key + ".json") };
        return {
          status: "continuation-required",
          projectionId,
          processed: state.cursor,
          documentCount: steps.length,
          ...(state.personEdited.length ? { personEdited: state.personEdited } : {}),
          headActionRequired: true,
          userActionRequired: false,
          remoteCAS: false,
        };
      });
      results.push({ id: targetId, ...result });
    } catch (error) {
      results.push({
        id: targetId,
        status: error.rejectedWrite ? "request-rejected-no-write" : "publication-unconfirmed",
        reasonCode: error.code || "WORK_DOCUMENT_TRANSPORT_UNKNOWN",
        ...(error.primaryReasonCode ? { primaryReasonCode: error.primaryReasonCode } : {}),
        executionReplayAllowed: false,
        ...(error.candidateObservations
          ? {
              candidateObservations: error.candidateObservations,
              coverage: error.coverage,
              searchComplete: error.searchComplete,
              automaticRetryAllowed: false,
              attemptId: error.attemptId,
            }
          : {}),
        ...(error.rejectedWrite ? { rejectedWrite: error.rejectedWrite, retry: { targetId, attemptId: error.attemptId } } : {}),
        ...(error.rejectionRecordingFailure
          ? { rejectionRecordingFailure: error.rejectionRecordingFailure, observedServiceError: error.observedServiceError }
          : {}),
        headActionRequired: true,
        userActionRequired: false,
      });
    }
  }
  return {
    kind: "ProjectDocumentPublicationOutcome",
    authorityPlane: "P5",
    projectionId,
    destinations: results,
    status: results.every((r) => r.status === "current")
      ? "published"
      : results.some((r) => r.status === "continuation-required")
        ? "continuation-required"
        : "partial-or-unconfirmed",
    ordinaryWorkBlocked: false,
    reviewOrCheckpointCreated: false,
    taskEffectsReplayed: false,
  };
}
