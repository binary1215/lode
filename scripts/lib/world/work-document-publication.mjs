import fs from "node:fs";
import { workDocumentStore, projectDocumentStore, documentFailure } from "./work-document-store.mjs";
import { withLocalMutation, withLocalMutationAsync } from "../storage/project-mutation-lock.mjs";
import { readWorkDocumentBasis, renderWorkDocument, workDocumentHash } from "./work-document-source.mjs";
import { createNotionWorkDocumentAdapter, createBoundedNotionRequest, documentDestinationIdentity } from "./work-document-destinations.mjs";
import { DOCUMENT_LAYOUT_VERSION, documentTreeKey, openDocumentTree } from "./work-document-tree.mjs";
import { readProductModelCanon } from "./product-model.mjs";
import { readSessionWorkEvidenceOwner } from "../session/session-work-context.mjs";
import { readSessionWorkContext } from "../session/session-work-context.mjs";
import { withSessionRoute } from "../session/session-routing.mjs";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
// The pair identity covers the exact views and the Lode-selected feature keys.
const pairId = (basis, views, featureKeys) => workDocumentHash([basis.basisId, views.map((view) => view.viewId), ...(featureKeys.length ? [featureKeys] : [])]);
function selectedFeatureKeys(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some((key) => typeof key !== "string" || !key.trim() || key.length > 200))
    documentFailure("Select at most 16 Product feature keys.", "WORK_DOCUMENT_FEATURE_SELECTION_INVALID");
  return [...new Set(value)];
}

export function configureWorkDocuments({ root, sessionId, targets, expectedConfigurationDigest = null } = {}) {
  const store = workDocumentStore({ root, sessionId });
  if (!Array.isArray(targets) || targets.length > 8 || new Set(targets.map((value) => value.id)).size !== targets.length)
    documentFailure("Select bounded distinct destinations.");
  for (const target of targets) {
    if (
      !ID.test(target.id || "") ||
      !["obsidian", "notion"].includes(target.kind) ||
      !Array.isArray(target.todoIds) ||
      target.todoIds.length > 32 ||
      target.todoIds.some((id) => !/^todo-[a-z0-9][a-z0-9-]{0,79}$/.test(id)) ||
      typeof target.automatic !== "boolean"
    )
      documentFailure("Explicit destination and automatic task scope are required.");
    if (target.projectDocuments !== undefined && typeof target.projectDocuments !== "boolean") documentFailure("Project documentation scope must be explicit.");
    if (target.kind === "obsidian") {
      if (typeof target.vaultRoot !== "string" || !fs.lstatSync(target.vaultRoot).isDirectory() || fs.lstatSync(target.vaultRoot).isSymbolicLink())
        documentFailure("Select an existing vault.");
    } else if (
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(target.parentPageId || "") ||
      typeof target.tokenEnvironment !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(target.tokenEnvironment)
    )
      documentFailure("Select an exact Notion parent and explicit credential environment reference.");
    const allowed = [
      "id",
      "kind",
      "todoIds",
      "automatic",
      "projectDocuments",
      ...(target.kind === "obsidian" ? ["vaultRoot"] : ["parentPageId", "tokenEnvironment"]),
    ];
    if (Object.keys(target).some((key) => !allowed.includes(key))) documentFailure("Unsupported destination field.");
  }
  return withLocalMutation({ directory: store.file("configuration.lock") }, () => {
    const previous = store.read("configuration.json");
    const value = { targets, configurationDigest: workDocumentHash(targets) };
    if (previous?.configurationDigest === value.configurationDigest) return { status: "reused", ...value, externalEffects: 0 };
    if ((previous?.configurationDigest || null) !== expectedConfigurationDigest)
      documentFailure("Connection scope changed; use the current exact configuration.", "WORK_DOCUMENT_CONFIGURATION_CHANGED");
    store.write(["configuration.json"], value, true);
    return { status: "configured", ...value, externalEffects: 0 };
  });
}

// Receipts written before the readable layout carry no layoutVersion.
const labelLayout = (receipt) => (receipt && !receipt.layoutVersion ? { ...receipt, layout: "old-layout", layoutVersion: 1 } : receipt);
export function workDocumentStatus(options = {}) {
  const store = workDocumentStore(options),
    configuration = store.read("configuration.json");
  return {
    kind: "WorkDocumentStatusProjection",
    authorityPlane: "P4",
    projectId: store.owner.projectId,
    sessionId: store.owner.sessionId,
    status: configuration?.targets.length ? "configured" : "unconnected",
    configuration,
    ordinaryWorkBlocked: false,
    recoveryAuthority: false,
    executionReplayAllowed: false,
    ...(options.logicalKey && HEX.test(options.logicalKey)
      ? {
          destinations: (configuration?.targets || []).map((target) => ({
            id: target.id,
            current: labelLayout(
              store.read("current", `${workDocumentHash([target.id, target.kind, target.vaultRoot || target.parentPageId, options.logicalKey])}.json`),
            ),
          })),
        }
      : {}),
  };
}

export async function prepareWorkDocuments(options = {}) {
  const basis = await readWorkDocumentBasis(options);
  const views = ["human", "agent"].map((audience) => renderWorkDocument(basis, { audience, title: options.title }));
  const featureKeys = selectedFeatureKeys(options.featureKeys);
  const projection = { kind: "WorkDocumentPair", basis, views, featureKeys, projectionId: pairId(basis, views, featureKeys) };
  // Feature keys are checked against the current Product model; a key that is
  // not a Product feature is reported and never becomes a feature (or Canon).
  const owner = readSessionWorkEvidenceOwner({ root: options.root, sessionId: basis.sessionId });
  const features = new Set(readProductModelCanon({ projectRoot: owner.root, storage: owner.storage }).model.features.map((feature) => feature.key));
  const featureCheck = { accepted: featureKeys.filter((key) => features.has(key)), rejected: featureKeys.filter((key) => !features.has(key)) };
  const store = workDocumentStore({ root: options.root, sessionId: basis.sessionId });
  store.write(["prepared", `${projection.projectionId}.json`], projection);
  withLocalMutation({ directory: store.file("selection-locks", `${basis.logicalKey}.lock`) }, () =>
    store.write(
      ["selections", `${basis.logicalKey}.json`],
      {
        projectionId: projection.projectionId,
        logicalKey: basis.logicalKey,
        title: options.title,
        sourceSelection: { ...basis.selection, ...(featureKeys.length ? { featureKeys } : {}) },
        taskRevision: selectedRevision(basis),
        authority: "replaceable-HEAD-reading-selection-not-direction-or-publication",
      },
      true,
    ),
  );
  return {
    status: "prepared",
    ...projection,
    featureCheck,
    ...(featureCheck.rejected.length
      ? {
          rejectedFeatureKeys: featureCheck.rejected,
          rejectedFeatureKeysMeaning: "not-Product-features-result-goes-to-unclassified-unless-another-key-is-accepted",
        }
      : {}),
    publication: "not-attempted",
    ordinaryWorkBlocked: false,
  };
}

export function readWorkDocumentSelections({ root, sessionId, logicalKey, targetIds }) {
  const store = workDocumentStore({ root, sessionId }),
    status = workDocumentStatus({ root, sessionId, logicalKey });
  return {
    published: status.destinations
      .filter((target) => targetIds.includes(target.id) && target.current)
      .map((target) => ({ targetId: target.id, ...target.current })),
    draft: store.read("selections", `${logicalKey}.json`),
  };
}

async function configuredAdapter(target, basis, supplied) {
  if (supplied?.[target.id]) return supplied[target.id];
  if (target.kind === "obsidian") return { kind: "obsidian", identity: workDocumentHash(["obsidian-tree", documentDestinationIdentity(target)]) };
  // Only an explicitly connected environment reference is read, at effect time.
  const token = process.env[target.tokenEnvironment];
  if (!token) documentFailure("The configured Notion connection is unavailable.", "WORK_DOCUMENT_UNCONNECTED");
  return createNotionWorkDocumentAdapter({ parentPageId: target.parentPageId, request: createBoundedNotionRequest({ token }) });
}

function selectedRevision(basis) {
  if (basis.todoId) return basis.taskState.items.find((task) => task.todoId === basis.todoId)?.revision || null;
  const records = basis.records.filter((record) => record.role === "selected-task");
  const parents = new Set(records.map((record) => record.content.workLink?.predecessor?.evidenceId));
  const leaves = records.filter((record) => !parents.has(record.evidenceId));
  return leaves.length === 1 ? { evidenceId: leaves[0].evidenceId, evidenceDigest: leaves[0].evidenceDigest } : null;
}
function currentEligibility(basis) {
  if (!basis.taskState)
    return {
      eligible: selectedRevision(basis) !== null,
      scope: "explicit-manual-original-not-task-completion",
      ...(selectedRevision(basis) ? {} : { reasonCode: "WORK_DOCUMENT_SCOPE_AMBIGUOUS" }),
    };
  const task = basis.taskState.items.find((item) => item.todoId === basis.todoId);
  if (
    basis.taskState.coverage.status !== "all-current-originals-inspected" ||
    !task ||
    task.status === "conflict" ||
    task.missingPriors?.length ||
    !basis.records.some(
      (record) => record.role === "selected-task" && record.evidenceId === task.revision?.evidenceId && record.evidenceDigest === task.revision?.evidenceDigest,
    )
  )
    return {
      eligible: false,
      reasonCode: "WORK_DOCUMENT_TASK_REVISION_UNCERTAIN",
      currentRecordedTask: task
        ? { todoId: task.todoId, status: task.status, revision: task.revision, reason: task.reason || null, nextAction: task.nextAction || null }
        : null,
      remoteDocumentState: "previous-published-basis-not-updated",
    };
  if (task.status === "completed") {
    const record = basis.records.find((value) => value.evidenceId === task.revision.evidenceId);
    // This checks that a result body was supplied, never whether its prose is
    // semantically sufficient, true, tested or approved. The view stays an
    // attributed report; a pure analysis needs no artificial file attachment.
    if (!record.content.summary && !record.content.observedWork.length && !record.content.judgments.length)
      return {
        eligible: false,
        reasonCode: "WORK_DOCUMENT_RESULT_EVIDENCE_MISSING",
        resultClaimOnly: true,
      };
  }
  return { eligible: true, taskStatus: task.status, completionAuthority: false };
}

async function advances(root, basis, previous) {
  if (!previous || previous.basisId === basis.basisId) return true;
  const target = previous.taskRevision;
  if (!target) return false;
  const records = new Map(basis.records.filter((record) => record.role === "selected-task").map((record) => [record.evidenceId, record]));
  const selected = selectedRevision(basis),
    start = records.get(selected?.evidenceId);
  if (!start) return false;
  const queue = [start],
    seen = new Set();
  while (queue.length && seen.size < 64) {
    const record = queue.shift();
    if (seen.has(record.evidenceId)) continue;
    seen.add(record.evidenceId);
    if (record.evidenceId === target.evidenceId && record.evidenceDigest === target.evidenceDigest) return true;
    const task = record.content.todos?.find((item) => item.todoId === basis.todoId);
    const refs = basis.todoId ? [task?.prior, ...(task?.resolves || [])].filter(Boolean) : [record.content.workLink?.predecessor].filter(Boolean);
    for (const ref of refs) {
      let original = records.get(ref.evidenceId);
      if (!original) {
        const read = withSessionRoute(root, basis.sessionId, () =>
          readSessionWorkContext({ root, evidenceIds: [ref.evidenceId], expectedSessionId: basis.sessionId, maxRecords: 1, maxCharacters: 524288 }),
        );
        original = read.records[0];
      }
      if (!original || original.evidenceDigest !== ref.evidenceDigest) return false;
      queue.push(original);
    }
  }
  return false;
}

export async function publishWorkDocuments({ root, sessionId, projectionId, targetIds, adapters, retryRejectedWrites = [] } = {}) {
  if (!HEX.test(projectionId || "") || !Array.isArray(targetIds) || !targetIds.length || targetIds.length > 8 || new Set(targetIds).size !== targetIds.length)
    documentFailure("Select a prepared pair and destinations.");
  if (
    !Array.isArray(retryRejectedWrites) ||
    retryRejectedWrites.length > 8 ||
    retryRejectedWrites.some(
      (ref) =>
        !targetIds.includes(ref?.targetId) || !HEX.test(ref?.attemptId || "") || Object.keys(ref).some((key) => !["targetId", "attemptId"].includes(key)),
    ) ||
    new Set(retryRejectedWrites.map((ref) => ref.targetId)).size !== retryRejectedWrites.length
  )
    documentFailure("Select exact rejected attempts for explicit retry.");
  const store = workDocumentStore({ root, sessionId });
  const prepared = store.read("prepared", `${projectionId}.json`);
  if (
    !prepared ||
    prepared.projectionId !== projectionId ||
    prepared.basis.projectId !== store.owner.projectId ||
    prepared.basis.sessionId !== store.owner.sessionId
  )
    documentFailure("Prepared document owner differs.");
  const current = await readWorkDocumentBasis({ root, ...prepared.basis.selection });
  const regenerated = ["human", "agent"].map((audience) => renderWorkDocument(current, { audience, title: prepared.views[0].title }));
  if (pairId(current, regenerated, prepared.featureKeys || []) !== projectionId || workDocumentHash(regenerated) !== workDocumentHash(prepared.views))
    return { status: "source-basis-changed", localDocumentsAvailable: true, destinations: [], ordinaryWorkBlocked: false };
  const eligibility = currentEligibility(current);
  if (!eligibility.eligible)
    return { status: "document-result-unconfirmed", ...eligibility, localDocumentsAvailable: true, destinations: [], ordinaryWorkBlocked: false };
  const configuration = store.read("configuration.json");
  const results = [];
  for (const id of targetIds) {
    const target = configuration?.targets.find((value) => value.id === id);
    if (!target) {
      results.push({ id, status: "unconnected" });
      continue;
    }
    try {
      const adapter = await configuredAdapter(target, current, adapters);
      const key = workDocumentHash([id, target.kind, target.vaultRoot || target.parentPageId, current.logicalKey]);
      const result = await withLocalMutationAsync({ directory: store.file("locks", `${key}.lock`), timeoutMs: 0 }, () =>
        publishPair({
          root,
          store,
          prepared,
          adapter,
          key,
          target,
          configurationDigest: configuration.configurationDigest,
          retryAttemptId: retryRejectedWrites.find((ref) => ref.targetId === id)?.attemptId,
        }),
      );
      results.push({ id, ...result });
    } catch (error) {
      // A Notion publication has a bounded number of requests. Completed steps are
      // journaled, so publishing the same projection again continues the tree.
      if (error.code === "WORK_DOCUMENT_TRANSPORT_BUDGET" && !error.rejectedWrite) {
        results.push({
          id,
          status: "continuation-required",
          reasonCode: error.code,
          followUp: { action: "publish-the-same-projection-again", projectionId, targetIds: [id] },
          headActionRequired: true,
          userActionRequired: false,
          executionReplayAllowed: false,
        });
        continue;
      }
      results.push({
        id,
        status: error.rejectedWrite
          ? "request-rejected-no-write"
          : error.code === "WORK_DOCUMENT_PERMISSION_DENIED"
            ? "permission-denied"
            : "publication-unconfirmed",
        reasonCode: error.code || "WORK_DOCUMENT_TRANSPORT_UNKNOWN",
        // A name held by a file Lode did not write: it clears when the person
        // moves or renames that file.
        ...(error.occupiedPath ? { occupiedPath: error.occupiedPath } : {}),
        ...(error.recoveryLimit ? { recoveryLimit: error.recoveryLimit } : {}),
        executionReplayAllowed: false,
        ...(error.rejectedWrite
          ? {
              rejectedWrite: error.rejectedWrite,
              retry: { targetId: id, attemptId: error.attemptId },
              retryRequires: "explicit-same-request-after-cause-repair-no-automatic-retry",
            }
          : {}),
        ...(error.rejectionRecordingFailure
          ? { rejectionRecordingFailure: error.rejectionRecordingFailure, observedServiceError: error.observedServiceError, durableRejectionAvailable: false }
          : {}),
      });
    }
  }
  return {
    kind: "WorkDocumentPublicationOutcome",
    authorityPlane: "P5",
    status: results.every((value) => value.status === "current")
      ? "published"
      : results.every((value) => ["current", "continuation-required"].includes(value.status))
        ? "continuation-required"
        : "partial-or-unconfirmed",
    projectionId,
    destinations: results,
    ordinaryWorkBlocked: false,
    taskEffectsReplayed: false,
    reviewOrCheckpointCreated: false,
  };
}

// Old-layout records (no layoutVersion) are read as "published in the old
// layout": their documents stay where they are and are never re-recorded.
function oldLayoutReference(previous, basis) {
  if (!previous || previous.layoutVersion) return null;
  const human = previous.views?.find((view) => view.audience === "human");
  return {
    directory: `Lode/${basis.projectId}/${basis.sessionId}/${basis.logicalKey}`,
    file: human?.id || null,
    url: human?.url || null,
    startId: previous.startId,
    startName: "Start.md",
    currentText: previous.currentText,
  };
}

async function publishPair({ root, store, prepared, adapter, key, target, configurationDigest, retryAttemptId }) {
  adapter.beginPublication?.();
  const { basis } = prepared;
  const previous = store.read("current", `${key}.json`);
  if (!(await advances(root, basis, previous))) return { status: "historical-no-current-change", reasonCode: "WORK_DOCUMENT_NOT_EXPLICIT_SUCCESSOR" };
  // The same result already published in the old layout is not a next result:
  // nothing is copied into the new tree and the old Start is left alone.
  if (previous && !previous.layoutVersion && previous.basisId === basis.basisId)
    return {
      status: "current",
      layout: "old-layout",
      alreadyPublishedInOldLayout: true,
      basisId: basis.basisId,
      views: previous.views,
      remoteCAS: false,
      completionAuthority: false,
    };
  const projectStore = projectDocumentStore({ root, sessionId: basis.sessionId });
  const destination = documentDestinationIdentity(target);
  const treeKey = documentTreeKey(basis.projectId, destination);
  return withLocalMutationAsync({ directory: projectStore.file("locks", `${treeKey}.lock`), timeoutMs: 10000 }, async () => {
    // An explicit retry stays bound to the exact Session configuration it was
    // rejected under.
    if (retryAttemptId && projectStore.read("attempts", `${retryAttemptId}.json`)?.context?.configurationDigest !== configurationDigest)
      documentFailure("Explicit retry does not match the current rejected request.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
    const tree = openDocumentTree({
      store: projectStore,
      key: treeKey,
      target,
      adapter,
      permissionDigest: workDocumentHash([basis.projectId, destination, "explicit-document-destination-scope"]),
      retryAttemptId,
      attemptContext: { configurationDigest },
    });
    const published = await tree.publishResult({
      prepared,
      featureKeys: prepared.featureKeys || [],
      oldLayout: oldLayoutReference(previous, basis),
    });
    const { result, humanDoc, evidenceDoc } = published;
    const views = [
      {
        audience: "human",
        viewId: prepared.views[0].viewId,
        id: humanDoc.id,
        url: published.url(humanDoc),
        payloadDigest: workDocumentHash(humanDoc.lastWritten),
      },
      {
        audience: "agent",
        viewId: prepared.views[1].viewId,
        id: evidenceDoc.id,
        url: published.url(evidenceDoc),
        payloadDigest: workDocumentHash(evidenceDoc.lastWritten),
      },
    ];
    const featureKeys = { accepted: result.features, rejected: result.rejectedFeatureKeys };
    // Recheck the exact source and user-selected destination after all async work.
    const refreshed = await readWorkDocumentBasis({ root, ...basis.selection });
    if (refreshed.basisId !== basis.basisId || store.read("configuration.json")?.configurationDigest !== configurationDigest)
      return {
        status: "views-verified-current-not-updated",
        reasonCode: "WORK_DOCUMENT_SOURCE_OR_DESTINATION_CHANGED",
        views,
      };
    const receipt = {
      kind: "WorkDocumentPublicationReceipt",
      authorityPlane: "P5",
      layoutVersion: DOCUMENT_LAYOUT_VERSION,
      basisId: basis.basisId,
      projectionId: prepared.projectionId,
      selectedEvidenceIds: basis.records.filter((record) => record.role === "selected-task").map((record) => record.evidenceId),
      logicalKey: basis.logicalKey,
      adapterIdentity: adapter.identity,
      treeKey,
      result: { number: result.number, name: result.name, folder: result.folder, humanUrl: views[0].url, evidenceUrl: views[1].url },
      featureKeys,
      views,
      taskRevision: selectedRevision(basis),
      sourceSelection: { ...basis.selection, ...(prepared.featureKeys?.length ? { featureKeys: prepared.featureKeys } : {}) },
      title: prepared.views[0].title,
      readbackScope: "result-documents-and-folder-list-regions",
      remoteCAS: false,
      currentMeans: "last-verified-published-basis-not-all-unpublished-changes",
      executionReplayAllowed: false,
    };
    store.write(["receipts", `${workDocumentHash(receipt)}.json`], receipt);
    store.write(["current", `${key}.json`], receipt, true);
    return {
      status: "current",
      result: { number: result.number, name: result.name, url: views[0].url, evidenceUrl: views[1].url },
      basisId: basis.basisId,
      views,
      featureKeys,
      ...(featureKeys.rejected.length
        ? {
            rejectedFeatureKeys: featureKeys.rejected,
            rejectedFeatureKeysMeaning: "not-Product-features-result-placed-in-unclassified-or-first-accepted-feature",
          }
        : {}),
      ...(tree.report.personEdited.length ? { personEdited: tree.report.personEdited } : {}),
      ...(published.oldLayoutLink ? { oldLayoutLink: published.oldLayoutLink } : {}),
      ...(published.featureChangeIgnored ? { featureChangeIgnored: published.featureChangeIgnored } : {}),
      remoteCAS: false,
      crossDestinationAtomicity: false,
      completionAuthority: false,
    };
  });
}
