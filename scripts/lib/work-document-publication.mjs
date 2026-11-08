import fs from "node:fs";
import { createDocumentEffectWriter } from "./work-document-effect-writer.mjs";
import { workDocumentStore, documentFailure } from "./work-document-store.mjs";
import { withLocalMutation, withLocalMutationAsync } from "./project-mutation-lock.mjs";
import { readWorkDocumentBasis, renderWorkDocument, resolveWorkDocumentLinks, workDocumentHash } from "./work-document-source.mjs";
import { createNotionWorkDocumentAdapter, createObsidianWorkDocumentAdapter, createBoundedNotionRequest } from "./work-document-destinations.mjs";
import { readSessionWorkContext } from "./session-work-context.mjs";
import { withSessionRoute } from "./session-routing.mjs";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
const marker = (key) => `Lode document identity: ${key}`;
const managed = (text) => `Lode current links begin\n\n${text}\n\nLode current links end`;
const body = (markdown, key) => `${markdown.trimEnd()}\n\n${marker(key)}\n`;

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
            current: store.read("current", `${workDocumentHash([target.id, target.kind, target.vaultRoot || target.parentPageId, options.logicalKey])}.json`),
          })),
        }
      : {}),
  };
}

export async function prepareWorkDocuments(options = {}) {
  const basis = await readWorkDocumentBasis(options);
  const views = ["human", "agent"].map((audience) => renderWorkDocument(basis, { audience, title: options.title }));
  const projection = { kind: "WorkDocumentPair", basis, views, projectionId: workDocumentHash([basis.basisId, views.map((view) => view.viewId)]) };
  const store = workDocumentStore({ root: options.root, sessionId: basis.sessionId });
  store.write(["prepared", `${projection.projectionId}.json`], projection);
  withLocalMutation({ directory: store.file("selection-locks", `${basis.logicalKey}.lock`) }, () =>
    store.write(
      ["selections", `${basis.logicalKey}.json`],
      {
        projectionId: projection.projectionId,
        logicalKey: basis.logicalKey,
        title: options.title,
        sourceSelection: basis.selection,
        taskRevision: selectedRevision(basis),
        authority: "replaceable-HEAD-reading-selection-not-direction-or-publication",
      },
      true,
    ),
  );
  return { status: "prepared", ...projection, publication: "not-attempted", ordinaryWorkBlocked: false };
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
  if (target.kind === "obsidian")
    return createObsidianWorkDocumentAdapter({ vaultRoot: target.vaultRoot, directory: `Lode/${basis.projectId}/${basis.sessionId}/${basis.logicalKey}` });
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
  if (
    workDocumentHash([current.basisId, regenerated.map((view) => view.viewId)]) !== projectionId ||
    workDocumentHash(regenerated) !== workDocumentHash(prepared.views)
  )
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
      results.push({
        id,
        status: error.rejectedWrite
          ? "request-rejected-no-write"
          : error.code === "WORK_DOCUMENT_PERMISSION_DENIED"
            ? "permission-denied"
            : "publication-unconfirmed",
        reasonCode: error.code || "WORK_DOCUMENT_TRANSPORT_UNKNOWN",
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
    status: results.every((value) => value.status === "current") ? "published" : "partial-or-unconfirmed",
    projectionId,
    destinations: results,
    ordinaryWorkBlocked: false,
    taskEffectsReplayed: false,
    reviewOrCheckpointCreated: false,
  };
}

async function publishPair({ root, store, prepared, adapter, key, target, configurationDigest, retryAttemptId }) {
  adapter.beginPublication?.();
  const { basis, views } = prepared;
  const previous = store.read("current", `${key}.json`);
  if (!(await advances(root, basis, previous))) return { status: "historical-no-current-change", reasonCode: "WORK_DOCUMENT_NOT_EXPLICIT_SUCCESSOR" };
  const { create, change, verify, readBound } = createDocumentEffectWriter({
    store,
    adapter,
    key,
    target,
    configurationDigest,
    prepared,
    previous,
    retryAttemptId,
  });
  const initial = managed("게시 확인 대기 중입니다. 작업 완료나 외부 배포 완료를 뜻하지 않습니다.");
  const startId = await create("start", "Start.md", "Lode work", body(`# Lode work\n\n${initial}`, basis.logicalKey));
  const notesId = await create(
    "notes",
    "Notes.md",
    "Personal notes",
    body("# Personal notes\n\n개인 메모는 여기에 보관합니다. Lode는 이 문서를 갱신하지 않습니다.", `${basis.logicalKey}-notes`),
  );
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
    verified.push({ audience: view.audience, viewId: view.viewId, url: adapter.url(id), ...(await verify(id, expected)) });
  }
  // Recheck the exact source and user-selected destination after all async work.
  const refreshed = await readWorkDocumentBasis({ root, ...basis.selection });
  if (refreshed.basisId !== basis.basisId || store.read("configuration.json")?.configurationDigest !== configurationDigest)
    return {
      status: "views-verified-current-not-updated",
      reasonCode: "WORK_DOCUMENT_SOURCE_OR_DESTINATION_CHANGED",
      views: verified,
    };
  const currentText =
    previous?.projectionId === prepared.projectionId
      ? previous.currentText
      : managed(
          `마지막으로 게시·조회 확인한 근거: ${basis.basisId}\n\n[사람용](${verified[0].url}) · [에이전트용](${verified[1].url}) · [개인 메모](${adapter.url(notesId)})\n\n${basis.taskState ? `기록된 작업 상태: ${basis.taskState.items[0].status}` : "명시적으로 선택한 작업 원문"}. 현재 미게시 변경 전체를 뜻하지 않습니다.${previous && previous.basisId !== basis.basisId ? `\n\n[이전 게시 문서](${previous.views[0].url})` : ""}`,
        );
  const oldText = previous?.currentText || initial;
  await change(startId, oldText, currentText);
  const start = await readBound(startId);
  if (!start.complete || start.warnings?.length || start.markdown.split(currentText).length !== 2)
    documentFailure("Current links are not uniquely readback-verified.");
  await adapter.read(notesId); // Existence/parent only: personal notes may change.
  // A user edit to either view between link updates is not silently accepted.
  for (let index = 0; index < pages.length; index++)
    await verify(
      pages[index].id,
      body(
        resolveWorkDocumentLinks(pages[index].view, { peer: adapter.url(pages[1 - index].id), start: adapter.url(startId) }).markdown,
        pages[index].view.viewId,
      ),
    );
  if ((await readWorkDocumentBasis({ root, ...basis.selection })).basisId !== basis.basisId)
    return { status: "current-observation-unknown", reasonCode: "WORK_DOCUMENT_SOURCE_CHANGED_DURING_LINK_UPDATE" };
  const receipt = {
    kind: "WorkDocumentPublicationReceipt",
    authorityPlane: "P5",
    basisId: basis.basisId,
    projectionId: prepared.projectionId,
    selectedEvidenceIds: basis.records.filter((record) => record.role === "selected-task").map((record) => record.evidenceId),
    logicalKey: basis.logicalKey,
    adapterIdentity: adapter.identity,
    startId,
    notesId,
    currentText,
    views: verified,
    taskRevision: selectedRevision(basis),
    sourceSelection: basis.selection,
    title: views[0].title,
    startReadbackDigest: workDocumentHash(start.markdown),
    readbackScope: "two-full-views-and-required-links",
    remoteCAS: false,
    currentMeans: "last-verified-published-basis-not-all-unpublished-changes",
    executionReplayAllowed: false,
  };
  store.write(["receipts", `${workDocumentHash(receipt)}.json`], receipt);
  store.write(["current", `${key}.json`], receipt, true);
  return {
    status: "current",
    start: adapter.url(startId),
    basisId: basis.basisId,
    views: verified,
    remoteCAS: false,
    crossDestinationAtomicity: false,
    completionAuthority: false,
  };
}
