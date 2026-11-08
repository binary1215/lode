import path from "node:path";
import { projectDocumentStore, workDocumentStore, documentFailure as fail, storeDocumentValue, readDocumentValue } from "./work-document-store.mjs";
import { readProjectDocumentBasis, projectDocumentNodeId, renderProjectDocumentPage } from "./project-document-hierarchy.mjs";
import { workDocumentHash as hash, readWorkDocumentBasis, renderWorkDocument } from "./work-document-source.mjs";
import { createDocumentEffectWriter } from "./work-document-effect-writer.mjs";
import {
  createNotionWorkDocumentAdapter,
  createBoundedNotionRequest,
  createObsidianWorkDocumentAdapter,
  documentDestinationIdentity,
  sameDocumentText,
} from "./work-document-destinations.mjs";
import { withLocalMutation, withLocalMutationAsync } from "./project-mutation-lock.mjs";

const HEX = /^[a-f0-9]{64}$/;
const nav = (text) => "Lode project links begin\n\n" + text + "\n\nLode project links end";
const literal = (text) =>
  String(text)
    .replace(/[\r\n<>]/g, " ")
    .replace(/([\\\x60*_[\]#!|])/g, "\\$1");
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
    hash([original.basis.basisId, original.views.map((view) => view.viewId)]) !== ref.projectionId
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
    for (const view of views) {
      const suffix = "[다른 읽기 뷰](lode-view:peer) · [시작 문서](lode-view:start)\n";
      if (!view.markdown.endsWith(suffix)) fail("Task navigation differs.");
      readingBody[view.audience] = view.markdown.slice(0, -suffix.length);
    }
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
  const basis = await currentBasis(options.root, selection, store.caller.sessionId),
    pages = [];
  for (const node of basis.nodes)
    for (const audience of ["human", "agent"]) {
      const view = renderProjectDocumentPage(basis, { nodeId: node.id, audience });
      pages.push({ nodeId: node.id, audience, viewId: view.viewId, valueDigest: storeDocumentValue(store, view) });
    }
  const projectionId = hash([basis.basisId, pages.map(({ nodeId, audience, viewId }) => ({ nodeId, audience, viewId }))]);
  const selectionDigest = storeDocumentValue(store, selection);
  store.write(["prepared", projectionId + ".json"], {
    kind: "ProjectDocumentPreparation",
    projectId: basis.projectId,
    projectionId,
    basisId: basis.basisId,
    selectionDigest,
    pagesDigest: storeDocumentValue(store, pages),
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
    pageCount: pages.length,
    coverage: basis.coverage,
    publication: "not-attempted",
    ordinaryWorkBlocked: false,
    previews: ["human", "agent"].map((audience) => renderProjectDocumentPage(basis, { nodeId: basis.rootId, audience })),
  };
}
function loadPreparation(store, projectionId) {
  if (!HEX.test(projectionId || "")) fail("Select an exact prepared hierarchy.");
  const prepared = store.read("prepared", projectionId + ".json");
  if (!prepared || prepared.projectId !== store.owner.projectId || prepared.projectionId !== projectionId)
    fail("Preparation owner differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  const pages = readDocumentValue(store, prepared.pagesDigest);
  if (hash([prepared.basisId, pages.map(({ nodeId, audience, viewId }) => ({ nodeId, audience, viewId }))]) !== projectionId)
    fail("Prepared index differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  return { ...prepared, pages, selection: readDocumentValue(store, prepared.selectionDigest) };
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
        const key = hash([store.owner.projectId, documentDestinationIdentity(target), "project-documents-v1"]);
        return {
          id: target.id,
          scopeEnabled: target.projectDocuments === true,
          current: store.read("current", key + ".json"),
          progress: store.read("progress", key + ".json"),
        };
      }),
  };
}
async function destination(target, projectId, supplied) {
  const identity = documentDestinationIdentity(target);
  if (supplied?.[target.id]) return { adapter: supplied[target.id], identity };
  if (target.kind === "obsidian")
    return { identity, adapter: createObsidianWorkDocumentAdapter({ vaultRoot: target.vaultRoot, directory: "Lode/" + projectId + "/ProjectDocuments" }) };
  const token = process.env[target.tokenEnvironment];
  if (!token) fail("The selected connection is unavailable.", "WORK_DOCUMENT_UNCONNECTED");
  return { identity, adapter: createNotionWorkDocumentAdapter({ parentPageId: target.parentPageId, request: createBoundedNotionRequest({ token }) }) };
}
function scope(adapter, namespace, remoteParent, identity) {
  const child = namespace === "root" ? adapter : adapter.scoped(adapter.kind === "notion" ? remoteParent : namespace);
  // Canonical physical vault, independent of path spelling/target alias.
  return adapter.kind === "obsidian" ? { ...child, identity: hash([identity, child.directory]) } : child;
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
      const { adapter, identity } = await destination(target, store.owner.projectId, adapters),
        key = hash([store.owner.projectId, identity, "project-documents-v1"]);
      const result = await withLocalMutationAsync({ directory: store.file("locks", key + ".lock"), timeoutMs: 0 }, async () => {
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
        const initial = nav("문서 준비 중입니다. 작업 완료나 외부 배포를 뜻하지 않습니다."),
          internalTarget = { id: key };
        const permissionDigest = hash([store.owner.projectId, identity, "explicit-project-document-scope"]);
        const entryParts = (logical) => ["entries", hash([key, logical]) + ".json"],
          pendingParts = (logical) => ["pending-page", hash([key, logical]) + ".json"];
        const retryRef = retryRejectedWrites.find((ref) => ref.targetId === targetId)?.attemptId;
        if (retryRef) {
          const attempt = store.read("attempts", retryRef + ".json"),
            outcome = store.read("outcomes", retryRef + ".json");
          const scopes = ["home", "notes", ...basis.nodes.flatMap((node) => ["human/" + node.id, "agent/" + node.id])].map((logical) => hash([key, logical]));
          if (!attempt?.scope || attempt.scope.targetId !== key || !scopes.includes(attempt.scope.key) || !outcome?.rejectedWrite)
            fail("Retry does not belong to this exact Project destination.", "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
        }
        const writerFor = (logical, raw) => {
          const writerKey = hash([key, logical]);
          const retry = retryRef && store.read("attempts", retryRef + ".json")?.scope?.key === writerKey ? retryRef : undefined;
          const guarded = {
            ...raw,
            create: async (input) => {
              await check();
              return raw.create(input);
            },
            replace: async (input) => {
              await check();
              return raw.replace(input);
            },
          };
          return createDocumentEffectWriter({
            store,
            adapter: guarded,
            key: writerKey,
            target: internalTarget,
            configurationDigest: permissionDigest,
            prepared,
            previous: null,
            retryAttemptId: retry,
            recordInputs: true,
            stableContainerIds: ["Start.md", "human.md", "agent.md", "Notes.md", ...basis.nodes.map((node) => node.id + ".md")],
          });
        };
        const ensure = async (logical, title, raw, documentId) => {
          let entry = store.read(...entryParts(logical));
          const writer = writerFor(logical, raw);
          if (!entry) {
            entry = {
              logical,
              scope: hash([key, logical]),
              documentId,
              title,
              initial: "# " + literal(title) + "\n\n" + initial + "\n\nLode document identity: " + hash([key, logical]) + "\n",
            };
            if (logical === "notes") entry.initial = "# Personal notes\n\n개인 메모는 여기에 보관합니다. Lode는 이 문서를 갱신하지 않습니다.\n";
            store.write(entryParts(logical), entry);
          }
          if (entry.scope !== hash([key, logical]) || entry.logical !== logical || entry.documentId !== documentId)
            fail("Page owner differs.", "WORK_DOCUMENT_RECORD_TAMPER");
          if (!entry.id) {
            entry = { ...entry, id: await writer.create(logical, entry.documentId, entry.title, entry.initial) };
            store.write(entryParts(logical), entry, true);
          }
          return { entry, writer, raw };
        };
        const observedBody = async (item) => {
          const pending = store.read(...pendingParts(item.entry.logical));
          if (pending?.oldText) {
            await item.writer.settleKnownChange(item.entry.id, pending.oldText, pending.desired.trimEnd());
            await item.writer.reconcileChangeBinding(item.entry.id, pending.oldText, pending.desired.trimEnd());
          }
          const observed = await item.writer.readBound(item.entry.id),
            expected = item.entry.markdown || item.entry.initial;
          if (!observed.complete || observed.warnings?.length) fail("Page read is incomplete.", "WORK_DOCUMENT_REMOTE_DRIFT");
          if (!sameDocumentText(observed.markdown, expected)) {
            if (!pending || !sameDocumentText(observed.markdown, pending.desired)) fail("Page was edited or replaced.", "WORK_DOCUMENT_REMOTE_DRIFT");
            // Existing bound resource + exact pre-write input, not title/marker.
            item.entry = { ...item.entry, markdown: pending.desired, viewId: pending.viewId || null };
            store.write(entryParts(item.entry.logical), item.entry, true);
          }
          return item.entry.markdown || item.entry.initial;
        };
        const rootAdapter = scope(adapter, "root", null, identity);
        const home = await ensure("home", basis.title + " · " + basis.projectId.slice(-8), rootAdapter, "Start.md");
        await observedBody(home);
        const previous = store.read("current", key + ".json");
        if (previous && previous.projectionId !== projectionId) {
          // Stable linked pages are not a remote atomic snapshot. Disclose the
          // mixed in-progress reading scope before changing any child body.
          const published = home.entry.publishedMarkdown || home.entry.markdown || home.entry.initial;
          const pendingHome =
            "# 문서 갱신 중 — 아직 전체 게시 미확정\n\n이 링크들은 서로 다른 갱신 시점의 문서로 이어질 수 있습니다." +
            "\n\n이전 마지막 검증 근거: " +
            previous.basisId +
            "\n\n준비 중인 근거: " +
            basis.basisId +
            "\n\n---\n\n" +
            published;
          const old = await observedBody(home);
          if (!sameDocumentText(old, pendingHome)) {
            home.entry = { ...home.entry, publishedMarkdown: published };
            store.write(entryParts("home"), home.entry, true);
            store.write(pendingParts("home"), { desired: pendingHome, projectionId, oldText: old.trimEnd(), priorDigest: hash(old) }, true);
            await home.writer.change(home.entry.id, old.trimEnd(), pendingHome.trimEnd());
            await home.writer.verify(home.entry.id, pendingHome);
            home.entry = { ...home.entry, markdown: pendingHome };
            store.write(entryParts("home"), home.entry, true);
          }
        }
        const projectAdapter = adapter.kind === "notion" ? adapter.scoped(home.entry.id) : rootAdapter,
          readers = {};
        for (const audience of ["human", "agent"]) {
          const reader = await ensure(audience + "/" + basis.rootId, basis.title + " · " + audience, projectAdapter, audience + ".md");
          await observedBody(reader);
          readers[audience] = { ...reader, children: scope(adapter, audience, reader.entry.id, identity) };
        }
        const notes = await ensure("notes", "Personal notes", projectAdapter, "Notes.md");
        await notes.writer.readBound(notes.entry.id); // personal body is never updated
        const location = (nodeId, audience) => {
          const entry = store.read(...entryParts(audience + "/" + nodeId));
          if (!entry?.id) fail("A referenced page is not allocated.", "PROJECT_DOCUMENT_LINK_PENDING");
          return { id: entry.id, raw: nodeId === basis.rootId ? projectAdapter : readers[audience].children };
        };
        const url = (from, to) =>
          adapter.kind === "notion"
            ? to.raw.url(to.id)
            : path.posix
                .relative(from.raw.directory, to.raw.directory + "/" + to.id)
                .split("/")
                .map(encodeURIComponent)
                .join("/");
        const pages = prepared.pages
          .slice()
          .sort(
            (a, b) =>
              (a.nodeId === basis.rootId ? 1 : 0) - (b.nodeId === basis.rootId ? 1 : 0) ||
              a.nodeId.localeCompare(b.nodeId) ||
              a.audience.localeCompare(b.audience),
          );
        let state = store.read("progress", key + ".json"),
          operations = 0;
        if (state?.projectionId !== projectionId) state = { projectionId, phase: "allocate", cursor: 0, verificationCursor: 0 };
        const saveState = () => store.write(["progress", key + ".json"], state, true);
        if (state.phase === "allocate") {
          while (state.cursor < pages.length && operations++ < maxPageOperations) {
            const page = pages[state.cursor],
              node = basis.nodes.find((n) => n.id === page.nodeId);
            if (page.nodeId !== basis.rootId) await ensure(page.audience + "/" + page.nodeId, node.title, readers[page.audience].children, page.nodeId + ".md");
            state.cursor++;
            saveState();
          }
          if (state.cursor === pages.length) {
            state = { ...state, phase: "render", cursor: 0 };
            saveState();
          }
        } else if (state.phase === "render") {
          while (state.cursor < pages.length && operations++ < maxPageOperations) {
            const page = pages[state.cursor],
              logical = page.audience + "/" + page.nodeId,
              where = location(page.nodeId, page.audience);
            const item = { entry: store.read(...entryParts(logical)), raw: where.raw, writer: writerFor(logical, where.raw) };
            const view = renderProjectDocumentPage(basis, {
              nodeId: page.nodeId,
              audience: page.audience,
              publicationStateUrl: url(where, { id: home.entry.id, raw: rootAdapter }),
              resolveLink: (id, audience) => url(where, location(id, audience)),
            });
            let desired = view.markdown + "\nLode document identity: " + item.entry.scope + "\n",
              old = await observedBody(item);
            // Same exact source/render identity and the still-verified current
            // body: retain its existing history link, rather than archive the
            // link itself on an unrelated Project publication.
            if (item.entry.viewId === view.viewId && old.startsWith(desired)) desired = old;
            const baseDigest = hash(desired),
              pending = store.read(...pendingParts(logical));
            if (pending?.projectionId === projectionId && pending.baseDigest === baseDigest) desired = pending.desired;
            if (!sameDocumentText(old, desired)) {
              if (item.entry.markdown) {
                const historyId = hash([logical, old]),
                  filename = "history-" + historyId + ".md";
                const remoteId = await item.writer.create(
                  "history-" + historyId,
                  filename,
                  item.entry.title + " · 이전 게시",
                  "# 이전 게시\n\n아래는 이전에 확인한 읽기 본문입니다. 소속·상태·검증은 당시 인용한 근거의 범위이며, 안정 페이지 링크는 현재 읽기 뷰로 이어질 수 있습니다.\n\n" +
                    old,
                );
                desired += "\n[이전 게시](" + url(where, { id: remoteId, raw: where.raw }) + ")\n";
              }
              store.write(
                pendingParts(logical),
                { desired, projectionId, baseDigest, viewId: view.viewId, oldText: old.trimEnd(), priorDigest: hash(old) },
                true,
              );
              await item.writer.change(item.entry.id, old.trimEnd(), desired.trimEnd());
            }
            await item.writer.verify(item.entry.id, desired);
            await check();
            store.write(entryParts(logical), { ...item.entry, markdown: desired, viewId: view.viewId, projectionId }, true);
            state.cursor++;
            saveState();
          }
          if (state.cursor === pages.length) {
            state = { ...state, phase: "verify", verificationCursor: 0 };
            saveState();
          }
        } else if (state.phase === "verify") {
          while (state.verificationCursor < pages.length && operations++ < maxPageOperations) {
            const page = pages[state.verificationCursor],
              logical = page.audience + "/" + page.nodeId,
              where = location(page.nodeId, page.audience);
            const entry = store.read(...entryParts(logical));
            await writerFor(logical, where.raw).verify(entry.id, entry.markdown);
            state.verificationCursor++;
            saveState();
          }
          if (state.verificationCursor === pages.length) {
            state = { ...state, phase: "promote" };
            saveState();
          }
        }
        if (state.phase === "promote") {
          await check();
          const desired =
            "# " +
            literal(basis.title) +
            " · " +
            basis.projectId.slice(-8) +
            "\n\n" +
            nav(
              "[사람용](" +
                url(home, location(basis.rootId, "human")) +
                ") · [에이전트용](" +
                url(home, location(basis.rootId, "agent")) +
                ") · [개인 메모](" +
                url(home, { id: notes.entry.id, raw: projectAdapter }) +
                ")\n\n마지막으로 게시·조회 확인한 근거: " +
                basis.basisId +
                "\n\n범위: 현재 제품 설명과 명시적으로 선택한 작업 원문. 전체 세션·서비스 동작·실행 완료를 뜻하지 않습니다.",
            ) +
            "\n\nLode document identity: " +
            home.entry.scope +
            "\n";
          const old = await observedBody(home);
          store.write(pendingParts("home"), { desired, projectionId, oldText: old.trimEnd(), priorDigest: hash(old) }, true);
          await home.writer.change(home.entry.id, old.trimEnd(), desired.trimEnd());
          await home.writer.verify(home.entry.id, desired);
          await check();
          store.write(entryParts("home"), { ...home.entry, markdown: desired, publishedMarkdown: desired, projectionId }, true);
          const receipt = {
            kind: "ProjectDocumentPublicationReceipt",
            authorityPlane: "P5",
            projectId: basis.projectId,
            projectionId,
            basisId: basis.basisId,
            destinationIdentity: identity,
            homeId: home.entry.id,
            homeUrl: adapter.kind === "notion" ? adapter.url(home.entry.id) : home.entry.id,
            pages: pages.length,
            verifiedScope: "paged-last-observations-not-simultaneous-remote-CAS",
            remoteCAS: false,
            completedWorkInferred: false,
            recoveryAuthority: false,
          };
          store.write(["receipts", hash(receipt) + ".json"], receipt);
          store.write(["current", key + ".json"], receipt, true);
          state = { ...state, phase: "complete" };
          saveState();
          return { status: "current", ...receipt };
        }
        if (state.phase === "complete") return { status: "current", ...store.read("current", key + ".json") };
        return {
          status: "continuation-required",
          projectionId,
          phase: state.phase,
          processed: state.phase === "verify" ? state.verificationCursor : state.cursor,
          pageCount: pages.length,
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
