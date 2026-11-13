import fs from "node:fs";
import path from "node:path";
import { workDocumentHash as hash, readableText, recordedTime, WORK_DOCUMENT_RENDERER } from "./work-document-source.mjs";
import { documentFailure as fail, readDocumentValue } from "./work-document-store.mjs";
import { createDocumentEffectWriter } from "./work-document-effect-writer.mjs";
import { createObsidianWorkDocumentAdapter, encodeLinkSegment, sameDocumentText, safeVaultName } from "./work-document-destinations.mjs";
import { readProductModelCanon } from "./product-model.mjs";

// Layout v2: Lode/<product>/<feature group>/<feature>/ with readable names.
// Human documents carry no management lines; the evidence document beside them
// (근거/) holds identities and digests. Lode records stay the source of truth:
// nothing here parses a published document to decide anything.
export const DOCUMENT_LAYOUT_VERSION = 2;
const NAME_CAP = 40;
const PATH_BUDGET = 180;
// The longest file Lode places inside a folder: 근거/<40> (suffix) 결과 N 근거.md.
const LEAF_RESERVE = "/근거/".length + NAME_CAP + " (abcdef) 결과 9999 근거.md".length;
const NOTICE = "이 문서는 Lode가 게시한 읽기용 사본입니다. 승인·지시·완료 증명이 아닙니다. 여기서 고쳐도 Lode의 기록은 바뀌지 않습니다.";
const SPECIAL = {
  unclassified: { name: "소속 미확인", label: "기능이 정해지지 않은 결과" },
  conditions: { name: "결정과 조건", label: "결정·요구·제약·역량·정책" },
  records: { name: "작업 기록", label: "작업과 세션 목록" },
};
const ENTITY_FIELDS = {
  Decision: ["decisions", "결정"],
  Requirement: ["requirements", "요구"],
  Constraint: ["constraints", "제약"],
  Capability: ["capabilities", "역량"],
  Policy: ["policies", "정책"],
};
const RESULT_STATUS = { completed: "완료", partial: "진행 중", pending: "할 일", waiting: "기다리는 중", cancelled: "취소됨", conflict: "확인 필요" };

export function readableName(value, fallback = "이름 없음") {
  let name = String(value ?? "")
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  // The cap counts UTF-16 units (what path limits count) and never splits a pair.
  let capped = "";
  for (const character of name) {
    if (capped.length + character.length > NAME_CAP) break;
    capped += character;
  }
  name = capped.replace(/[.\s]+$/, "");
  if (!name) name = fallback;
  // Windows refuses a device name as the stem, also with an extension or spaces.
  return name.replace(/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\s*(\.|$))/i, "$1 문서");
}
const lower = (name) => name.normalize("NFC").toLowerCase();
const line = (value) => readableText(String(value).replace(/\s+/g, " "));

export function documentTreeKey(projectId, destinationIdentity) {
  return hash([projectId, destinationIdentity, "readable-document-tree-v2"]);
}

export function readDocumentTree(store, key) {
  return store.read("tree", key + ".json");
}

// One open tree for one exact destination. All writes go through the existing
// journaled effect writer (no duplicate create on an unknown outcome).
export function openDocumentTree({ store, key, target, adapter, permissionDigest, retryAttemptId, attemptContext = null, check = async () => {} }) {
  const owner = store.caller;
  const notion = adapter.kind === "notion";
  if (!notion && adapter.kind !== "obsidian") fail("Unknown document destination.");
  const vault = notion ? null : fs.realpathSync(target.vaultRoot);
  let state = readDocumentTree(store, key) || {
    layoutVersion: DOCUMENT_LAYOUT_VERSION,
    productName: null,
    rootNames: {},
    folders: {},
    featureFolders: {},
    documents: {},
    results: {},
    tasks: {},
    oldLayout: {},
    sequence: 0,
  };
  if (state.layoutVersion !== DOCUMENT_LAYOUT_VERSION) fail("Unknown document layout record.", "WORK_DOCUMENT_RECORD_TAMPER");
  const report = { personEdited: [], created: [], updated: [] };
  // One entry per document and finding within a publication.
  const noted = new Map();
  const note = (entry, documentKey) => {
    const id = JSON.stringify([documentKey, entry.status, entry.region ?? null]);
    if (noted.has(id)) return;
    noted.set(id, entry);
    report.personEdited.push(entry);
  };
  // A finding settled later in the same publication is not reported.
  const unnote = (documentKey, status) => {
    const id = JSON.stringify([documentKey, status, null]);
    if (!noted.has(id)) return;
    report.personEdited.splice(report.personEdited.indexOf(noted.get(id)), 1);
    noted.delete(id);
  };
  const save = () => store.write(["tree", key + ".json"], state, true);
  const canonRead = readProductModelCanon({ projectRoot: owner.root, storage: owner.storage });
  const canon = canonRead.model;
  // "First-listed parent" means the order written in the Product model file; the
  // normalized model sorts reference keys, so the written order is read from the
  // same file (falling back to the normalized order).
  const writtenParents = (() => {
    const order = new Map();
    try {
      const document = JSON.parse(fs.readFileSync(canonRead.file, "utf8"));
      for (const group of document.featureGroups || []) order.set("group:" + group.key, group.parentFeatureGroupKeys || []);
      for (const feature of document.features || []) order.set("feature:" + feature.key, feature.featureGroupKeys || []);
    } catch {
      // No file or unreadable: the normalized order is used.
    }
    return order;
  })();
  const parentKeys = (kind, entityKey) => {
    const value =
      kind === "group"
        ? canon.featureGroups.find((item) => item.key === entityKey)
        : kind === "feature"
          ? canon.features.find((item) => item.key === entityKey)
          : null;
    const known = kind === "group" ? value?.parentFeatureGroupKeys || [] : value?.featureGroupKeys || [];
    const written = (writtenParents.get(kind + ":" + entityKey) || []).filter((groupKey) => known.includes(groupKey));
    return [...new Set([...written, ...known])].filter((groupKey) => canon.featureGroups.some((group) => group.key === groupKey));
  };
  const entity = (kind, entityKey) =>
    kind === "group"
      ? canon.featureGroups.find((value) => value.key === entityKey)
      : kind === "feature"
        ? canon.features.find((value) => value.key === entityKey)
        : null;
  const recordedIds = () => new Set(Object.values(state.documents).flatMap((doc) => (doc.id ? [doc.id] : [])));

  // ---- locations ----
  const folderDir = (folder) => "Lode/" + folder.segments.join("/");
  const parentPage = (doc) => {
    const folder = state.folders[doc.folder];
    if (doc.role === "evidence") return state.documents["box:" + folder.key].id;
    if (doc.role === "folder") return folder.parent ? state.documents["doc:" + folder.parent].id : null;
    return state.documents["doc:" + folder.key].id;
  };
  const dirOf = (doc) => folderDir(state.folders[doc.folder]) + (doc.role === "evidence" ? "/근거" : "");
  const adapterFor = (doc) => {
    if (!notion) return createObsidianWorkDocumentAdapter({ vaultRoot: vault, directory: dirOf(doc) });
    const parent = parentPage(doc);
    return parent ? adapter.scoped(parent) : adapter;
  };
  const link = (from, to) => {
    if (notion) return to.id ? adapter.url(to.id) : null;
    return path.posix
      .relative(dirOf(from), dirOf(to) + "/" + to.name + ".md")
      .split("/")
      .map(encodeLinkSegment)
      .join("/");
  };
  const anchor = (from, to, label) => {
    const url = link(from, to);
    return url ? `[${line(label)}](${url})` : `${line(label)} (연결 준비 중)`;
  };
  const identity = (docKey) => hash([key, docKey]);

  // ---- writers ----
  const writerFor = (doc) => {
    const writerKey = hash([key, doc.key]);
    const retry = retryAttemptId && store.read("attempts", retryAttemptId + ".json")?.scope?.key === writerKey ? retryAttemptId : undefined;
    return createDocumentEffectWriter({
      store,
      adapter: adapterFor(doc),
      key: writerKey,
      target: { id: key },
      configurationDigest: permissionDigest,
      prepared: { projectionId: hash([key, "readable-document-tree"]) },
      previous: null,
      retryAttemptId: retry,
      recordInputs: true,
      recoverByTitle: notion,
      recordedElsewhere: (id) => id !== doc.id && recordedIds().has(id),
      attemptContext,
      identityByContent: true,
    });
  };
  const documentId = (doc) => (notion ? doc.name : doc.name + ".md");

  // ---- names ----
  const occupiedOnDisk = (dir, name) => !notion && fs.existsSync(path.join(vault, ...dir.split("/"), name));
  // Names are unique per folder (case-insensitive). A short suffix is added only
  // when a name is taken in that folder: by another Lode document or by a file
  // a person created there.
  // Under the configured Notion parent, other pages (another Project, a person's
  // page) may already use a title: Lode reads the parent's child titles once
  // and never reuses one, so recovery can rely on unique titles there.
  let rootListing = null;
  const listRoot = async () => {
    if (notion && !state.folders.product && !rootListing) rootListing = await adapter.childTitles();
  };
  // When the listing is incomplete, only a name carrying this tree's own short
  // suffix is used.
  const occupiedAtRoot = (name) =>
    notion
      ? rootListing?.complete
        ? rootListing.titles.some((title) => lower(title) === lower(name))
        : !/ \([a-f0-9]{4,}\)$/.test(name)
      : occupiedOnDisk("Lode", name);
  const allocate = (space, ownerKey, base, dir, extension = "", clashes = () => false) => {
    const existing = Object.values(space).find((value) => value.owner === ownerKey);
    if (existing) return existing.name;
    let name = base;
    const occupied = (candidate) => clashes(candidate) || (space === state.rootNames ? occupiedAtRoot(candidate) : occupiedOnDisk(dir, candidate + extension));
    for (let size = 4; space[lower(name)] || occupied(name); size += 2) {
      if (size > 16) fail("No free document name.", "WORK_DOCUMENT_NAME_UNAVAILABLE");
      name = `${base} (${hash([key, ownerKey]).slice(0, size)})`;
    }
    if (!safeVaultName(name + extension)) fail("Unsafe document name.", "WORK_DOCUMENT_NAME_UNAVAILABLE");
    space[lower(name)] = { owner: ownerKey, name };
    return name;
  };

  // ---- documents ----
  const declare = (docKey, fields) => {
    state.documents[docKey] ??= { key: docKey, id: null, createText: null, lastWritten: null, regions: {}, edited: false, ...fields };
    return state.documents[docKey];
  };
  const create = async (docKey, render) => {
    const doc = state.documents[docKey];
    if (doc.id) return doc;
    if (!doc.createText) {
      const value = render();
      doc.createText = value.text;
      doc.createRegions = value.regions || {};
      save();
    }
    await check();
    doc.id = await writerFor(doc).create(docKey, documentId(doc), doc.name, doc.createText);
    doc.lastWritten = doc.createText;
    doc.regions = doc.createRegions;
    save();
    report.created.push(doc.name);
    return doc;
  };
  const applyRegions = (text, before, after) => {
    let next = text;
    for (const [name, value] of Object.entries(after)) {
      if (before[name] === undefined || before[name] === value) continue;
      if (next.split(before[name]).length !== 2) return null;
      next = next.replace(before[name], () => value);
    }
    return next;
  };
  // Whole document when it is still exactly what Lode wrote last; otherwise only
  // the list regions whose last written text occurs exactly once. A person's
  // edit is reported, never overwritten.
  // A change is recorded before it is sent. An unfinished one (lost response,
  // pending async task, rejected request) is settled through the same journal
  // before anything else is decided about the document: never replayed blindly
  // and never mistaken for a person's edit.
  // The document no longer holds the text a change was made from: a person's
  // edit. It is kept and reported; the publication goes on.
  const keptAsEdited = (doc, pending = null, markdown = null) => {
    if (pending && typeof markdown === "string") {
      const text = markdown.replace(/\r\n/g, "\n");
      const holds = (value) => text.split(value).length === 2;
      const regions = { ...doc.regions };
      for (const [name, value] of Object.entries(pending.regions || {})) if (holds(value)) regions[name] = value;
      doc.regions = regions;
      if (Object.values(pending.regions || {}).every(holds)) doc.lastWritten = pending.lastWritten;
    }
    delete doc.pending;
    doc.edited = true;
    save();
    note({ document: doc.name, status: "person-edited-not-overwritten" }, doc.key);
    return false;
  };
  const send = async (doc, writer, pending, { skipCheck = false } = {}) => {
    if (!skipCheck) await check();
    if (pending.occurrence === undefined) pending = { ...pending, occurrence: (doc.changes = (doc.changes || 0) + 1) };
    doc.pending = pending;
    save();
    try {
      await writer.change(doc.id, pending.oldText, pending.newText, pending.occurrence);
    } catch (error) {
      // A Notion change whose outcome is unknown is never sent again. It stays
      // pending for this one document, which is reported; other documents go on.
      if (error.code === "WORK_DOCUMENT_UPDATE_UNKNOWN") {
        note({ document: doc.name, status: "update-unconfirmed" }, doc.key);
        return false;
      }
      if (error.code !== "WORK_DOCUMENT_REMOTE_DRIFT") throw error;
      const now = await writer.readBound(doc.id).catch(() => null);
      return keptAsEdited(doc, pending, now?.markdown ?? null);
    }
    const after = await writer.readBound(doc.id);
    if (!after.complete || after.warnings?.length) fail("Document read is incomplete.", "WORK_DOCUMENT_REMOTE_DRIFT");
    if (pending.whole ? !sameDocumentText(after.markdown, pending.lastWritten) : after.markdown.split(pending.newText).length !== 2) {
      // Lode's text is in place once, next to a person's addition: applied, and
      // the document is a person's from now on.
      if (!pending.whole || after.markdown.split(pending.newText).length !== 2) return keptAsEdited(doc, pending, after.markdown);
      Object.assign(doc, { lastWritten: pending.lastWritten, regions: pending.regions, edited: true });
      delete doc.pending;
      save();
      note({ document: doc.name, status: "person-edited-not-overwritten" }, doc.key);
      return true;
    }
    doc.lastWritten = pending.lastWritten;
    doc.regions = pending.regions;
    doc.edited = pending.edited;
    delete doc.pending;
    save();
    report.updated.push(doc.name);
    return true;
  };
  const missing = (error) => error?.code === "ENOENT" || error?.pageMissing === true;
  // Every unfinished change is settled before a publication writes anything
  // else, so a rejection or an unfinished async change stops it first. A
  // document a person deleted meanwhile is reported, not a stop.
  const settlePending = async () => {
    for (const doc of Object.values(state.documents).filter((value) => value.pending && value.id))
      try {
        await send(doc, writerFor(doc), doc.pending);
      } catch (error) {
        if (!missing(error)) throw error;
        note({ document: doc.name, status: "document-missing-not-recreated" }, doc.key);
      }
  };
  // A file's own line endings are kept when Lode rewrites part of it.
  const eol = (text, observed) => (observed.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text);
  const refresh = async (docKey, { whole = null, regions = {}, skipCheck = false } = {}) => {
    const doc = state.documents[docKey];
    if (!doc?.id) return;
    const writer = writerFor(doc);
    let observed;
    try {
      if (doc.pending) await send(doc, writer, doc.pending, { skipCheck });
      if (doc.pending) {
        // Still unconfirmed. The same text is not asked for again; a different
        // text (a new result line) is a new change made from the page as it is
        // now, which also brings the earlier text along.
        const wanted = whole ? whole.regions || {} : regions;
        const same =
          whole && doc.pending.whole
            ? sameDocumentText(whole.text, doc.pending.lastWritten)
            : Object.entries(wanted).every(([name, value]) => doc.pending.regions?.[name] === value);
        if (same) return;
        delete doc.pending;
        save();
        unnote(doc.key, "update-unconfirmed");
      }
      observed = await writer.readBound(doc.id);
    } catch (error) {
      if (!missing(error)) throw error;
      // A deleted or renamed document is a person's choice: it is reported and
      // not recreated; the publication goes on.
      note({ document: doc.name, status: "document-missing-not-recreated" }, doc.key);
      return;
    }
    if (!observed.complete || observed.warnings?.length) fail("Document read is incomplete.", "WORK_DOCUMENT_REMOTE_DRIFT");
    if (!doc.edited && doc.lastWritten && sameDocumentText(observed.markdown, doc.lastWritten)) {
      const next = whole ? whole.text : applyRegions(doc.lastWritten, doc.regions, regions);
      if (next === null) fail("Managed list text is ambiguous.", "WORK_DOCUMENT_REMOTE_DRIFT");
      const nextRegions = whole ? whole.regions || {} : { ...doc.regions, ...regions };
      if (!sameDocumentText(observed.markdown, next))
        await send(
          doc,
          writer,
          {
            whole: true,
            oldText: observed.markdown.trimEnd(),
            newText: eol(next.trimEnd(), observed.markdown),
            lastWritten: next,
            regions: nextRegions,
            edited: false,
          },
          { skipCheck },
        );
      else {
        doc.lastWritten = next;
        doc.regions = nextRegions;
        save();
      }
      return;
    }
    // A document a person brought back to exactly Lode's text is Lode's again.
    if (whole && sameDocumentText(observed.markdown, whole.text)) {
      Object.assign(doc, { edited: false, lastWritten: whole.text, regions: whole.regions || {} });
      save();
      return;
    }
    if (!doc.edited) {
      doc.edited = true;
      save();
    }
    if (whole) {
      regions = whole.regions || {};
      // Only a change outside the lists is withheld from a person's document.
      if (applyRegions(doc.lastWritten || "", doc.regions, regions) !== whole.text)
        note({ document: doc.name, status: "person-edited-not-overwritten", listsUpdated: Object.keys(regions) }, doc.key);
    }
    for (const [name, value] of Object.entries(regions)) {
      const before = doc.regions[name];
      if (before === undefined || before === value) continue;
      const current = await writer.readBound(doc.id);
      const oldText = eol(before, current.markdown),
        newText = eol(value, current.markdown);
      if (current.markdown.split(oldText).length !== 2 && current.markdown.split(newText).length === 2) {
        doc.regions = { ...doc.regions, [name]: value };
        save();
        continue;
      }
      if (current.markdown.split(oldText).length !== 2) {
        note({ document: doc.name, region: name, status: "person-edited-not-overwritten" }, doc.key);
        continue;
      }
      await send(
        doc,
        writer,
        {
          whole: false,
          oldText,
          newText,
          lastWritten: applyRegions(doc.lastWritten || "", { [name]: before }, { [name]: value }) ?? doc.lastWritten,
          regions: { ...doc.regions, [name]: value },
          edited: true,
        },
        { skipCheck },
      );
    }
  };

  // ---- folder placement ----
  // The current project title (or folder name). The product folder keeps the
  // name it was created with; the document title follows the current title.
  const productTitle = () => {
    const latest = store.read("selection.json");
    const title = latest ? readDocumentValue(store, latest.valueDigest)?.projectTitle : null;
    return title?.trim() || path.basename(owner.root);
  };
  const canonParent = (kind, entityKey) => {
    const first = parentKeys(kind, entityKey)[0];
    return first ? "group:" + first : "product";
  };
  // The same placement is used for vault folders and Notion pages so both show
  // one tree.
  const fits = (parent, name) => ("Lode/" + [...parent.segments, name + " (abcdef)"].join("/")).length + LEAF_RESERVE <= PATH_BUDGET;
  const placing = new Set();
  const placeFolder = (folderKey, kind, entityKey, display) => {
    if (state.folders[folderKey]) return state.folders[folderKey];
    let parentKey = null,
      segments,
      name;
    if (kind === "product") {
      state.productName ??= readableName(productTitle(), "프로젝트");
      name = allocate(state.rootNames, folderKey, state.productName, "Lode");
      segments = [name];
    } else {
      placing.add(folderKey);
      const wanted = kind === "group" || kind === "feature" ? canonParent(kind, entityKey) : "product";
      // A group cycle in the model never recurses: the folder goes under the product.
      let parent = ensurePlaced(placing.has(wanted) ? "product" : wanted);
      placing.delete(folderKey);
      const base = readableName(display);
      // Deep groups are flattened toward the product to keep vault paths short;
      // the hierarchy stays visible through links.
      while (parent.parent && !fits(parent, base)) parent = state.folders[parent.parent];
      parentKey = parent.key;
      // The fixed folder names under a product are kept for those folders: a
      // Product entity named like one gets a suffix. The fixed folders themselves
      // still check the disk like any other name.
      const reserved = (candidate) =>
        !SPECIAL[kind] && parent.kind === "product" && Object.values(SPECIAL).some((special) => lower(special.name) === lower(candidate));
      name = allocate(parent.dirs, folderKey, base, folderDir(parent), "", (candidate) =>
        Boolean((/\.md$/i.test(candidate) && parent.files[lower(candidate.slice(0, -3))]) || reserved(candidate)),
      );
      segments = [...parent.segments, name];
    }
    const folder = {
      key: folderKey,
      kind,
      entityKey,
      name,
      parent: parentKey,
      segments,
      dirs: { [lower("근거")]: { owner: "evidence", name: "근거" } },
      files: { [lower(name)]: { owner: "doc:" + folderKey, name } },
      evidenceFiles: { [lower(name + " 근거")]: { owner: "ev:" + folderKey, name: name + " 근거" } },
    };
    state.folders[folderKey] = folder;
    if (kind === "feature") state.featureFolders[entityKey] = folderDir(folder);
    declare("doc:" + folderKey, { folder: folderKey, role: "folder", name });
    declare("ev:" + folderKey, { folder: folderKey, role: "evidence", name: name + " 근거" });
    if (notion) declare("box:" + folderKey, { folder: folderKey, role: "container", name: "근거" });
    save();
    return folder;
  };
  const folderSpec = (folderKey) => {
    if (folderKey === "product") return ["product", null, productTitle()];
    if (SPECIAL[folderKey]) return [folderKey, null, SPECIAL[folderKey].name];
    const [kind, ...rest] = folderKey.split(":"),
      entityKey = rest.join(":");
    const value = entity(kind, entityKey);
    if (!value && !state.folders[folderKey]) fail("Unknown Product entity.", "PROJECT_DOCUMENT_ENTITY_UNKNOWN");
    return [kind, entityKey, value?.name || entityKey];
  };
  const ensurePlaced = (folderKey) => state.folders[folderKey] || placeFolder(folderKey, ...folderSpec(folderKey));

  // ---- rendering ----
  const displayName = (folder) => {
    if (folder.kind === "product") return productTitle();
    if (SPECIAL[folder.kind]) return SPECIAL[folder.kind].name;
    return entity(folder.kind, folder.entityKey)?.name || folder.name;
  };
  const folderDoc = (folderKey) => state.documents["doc:" + folderKey];
  const childFolders = (folder) => {
    const keys = new Set();
    for (const other of Object.values(state.folders)) {
      if (other.key === folder.key || !folderDoc(other.key)?.id) continue;
      if (other.parent === folder.key) keys.add(other.key);
      if (folder.kind === "group" || folder.kind === "product") {
        const value = entity(other.kind, other.entityKey);
        const parents = other.kind === "group" ? value?.parentFeatureGroupKeys || [] : other.kind === "feature" ? value?.featureGroupKeys || [] : null;
        if (parents && (folder.kind === "group" ? parents.includes(folder.entityKey) : !parents.length)) keys.add(other.key);
      }
    }
    const rank = { group: 0, feature: 1, unclassified: 2, conditions: 3, records: 4 };
    return [...keys]
      .map((childKey) => state.folders[childKey])
      .sort((a, b) => rank[a.kind] - rank[b.kind] || displayName(a).localeCompare(displayName(b)) || a.key.localeCompare(b.key));
  };
  const childrenRegion = (folder) => {
    const from = folderDoc(folder.key);
    const items = childFolders(folder).map(
      (child) =>
        `- ${anchor(from, folderDoc(child.key), displayName(child))} — ${child.kind === "group" ? "기능군" : child.kind === "feature" ? "기능" : SPECIAL[child.kind].label}`,
    );
    if (folder.kind === "conditions")
      items.push(
        ...Object.values(state.documents)
          .filter((doc) => doc.role === "entity" && doc.id)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((doc) => `- ${anchor(from, doc, doc.display || doc.name)} — ${ENTITY_FIELDS[doc.entityKind][1]}`),
      );
    return `## 구성\n\n${items.length ? items.join("\n") : "아직 없습니다."}`;
  };
  const resultsOf = (folder) =>
    Object.values(state.results)
      .filter((result) =>
        folder.kind === "feature" ? result.features.includes(folder.entityKey) : folder.kind === "unclassified" && result.folder === folder.key,
      )
      .filter((result) => state.documents["result:" + result.key]?.id)
      .sort((a, b) => b.sequence - a.sequence);
  const resultsRegion = (folder) => {
    const from = folderDoc(folder.key);
    const items = resultsOf(folder).map(
      (result) =>
        `- ${anchor(from, state.documents["result:" + result.key], result.name)} — ${RESULT_STATUS[result.status] || "기록됨"} · ${result.recordedAt ? recordedTime(result.recordedAt).slice(0, 10) : "날짜 미확인"}`,
    );
    return `## ${folder.kind === "feature" ? "이 기능의 결과" : "이 폴더의 결과"}\n\n${items.length ? items.join("\n") : "아직 게시된 결과가 없습니다."}`;
  };
  const parentsLine = (folder) => {
    const from = folderDoc(folder.key);
    let parents = [];
    if (folder.kind === "group" || folder.kind === "feature")
      parents = parentKeys(folder.kind, folder.entityKey)
        .map((groupKey) => state.folders["group:" + groupKey])
        .filter((parent) => parent && folderDoc(parent.key)?.id);
    if (!parents.length && folder.parent) parents = [state.folders[folder.parent]];
    return parents.length ? `상위: ${parents.map((parent) => anchor(from, folderDoc(parent.key), displayName(parent))).join(" · ")}` : null;
  };
  let extras = { narratives: new Map(), records: null };
  let recordsRegion = null;
  const narrativeSections = (kind, entityKey) => {
    const fresh = extras.narratives.get(kind + "/" + entityKey),
      kept = state.narratives?.[kind + "/" + entityKey];
    const narrative = fresh || kept;
    if (!narrative) return [];
    const out = [];
    // A kept explanation is about the model it was written for; once the model
    // changed it is marked until the next Project publication checks it again.
    if (narrative.historical || (!fresh && state.narrativesModelHash !== canon.productModelHash))
      out.push("아래 설명은 이전에 선택한 원문에 대한 것입니다. 현재 원문과 달라졌으며 현재 동작은 다시 확인해야 합니다.");
    for (const [field, label] of [
      ["purpose", "목적"],
      ["useFlow", "사용 흐름"],
      ["currentBehavior", "현재 동작에 대한 설명"],
      ["notes", "제약·확인할 점"],
    ])
      if (narrative[field]) out.push(`## ${label}\n\n${readableText(narrative[field])}`);
    return out;
  };
  const relatedConditions = (folder) => {
    const value = entity("feature", folder.entityKey);
    if (!value) return null;
    const refs = [
      ...(value.governedBy || []).map((ref) => [ref.kind, ref.key]),
      ...(value.capabilityKeys || []).map((capability) => ["Capability", capability]),
      ...(canon.policies || [])
        .filter((policy) => policy.appliesTo?.some((ref) => ref.kind === "Feature" && ref.key === value.key))
        .map((policy) => ["Policy", policy.key]),
    ];
    if (!refs.length) return null;
    const from = folderDoc(folder.key);
    return (
      "## 관련 결정과 조건\n\n" +
      refs
        .map(([kind, entityKey]) => {
          const target = ENTITY_FIELDS[kind] ? (canon[ENTITY_FIELDS[kind][0]] || []).find((item) => item.key === entityKey) : null;
          const label = target?.name || target?.statement || entityKey;
          const doc = state.documents[`entity:${kind}:${entityKey}`];
          return `- ${doc?.id ? anchor(from, doc, label) : line(label)}${ENTITY_FIELDS[kind] ? ` — ${ENTITY_FIELDS[kind][1]}` : ""}`;
        })
        .join("\n")
    );
  };
  const renderFolder = (folderKey) => {
    const folder = state.folders[folderKey],
      doc = folderDoc(folderKey),
      sections = [`# ${line(displayName(folder))}`],
      regions = {};
    if (folder.kind === "product") {
      // A managed region, so the in-progress line can be removed under the same
      // exactly-once rule as the lists, also from a document a person edited.
      const intro =
        canon.features.length || canon.featureGroups.length
          ? "제품 구성과 기능별 작업 결과를 아래에서 찾아볼 수 있습니다."
          : "제품 설명 원문이 아직 없습니다. 결과는 소속 미확인 폴더에서 읽을 수 있습니다.";
      sections.push((regions.intro = state.inProgress ? `문서를 갱신하는 중입니다. 다 끝날 때까지 일부 문서는 이전 내용일 수 있습니다.\n\n${intro}` : intro));
    }
    if (SPECIAL[folder.kind])
      sections.push(
        {
          unclassified: "기능이 아직 정해지지 않은 결과가 이 폴더에 놓입니다.",
          conditions: "제품 원문에 기록된 결정·요구·제약·역량·정책입니다.",
          records: "선택한 작업 기록을 시간 순서로 모았습니다.",
        }[folder.kind],
      );
    const value = entity(folder.kind, folder.entityKey);
    if (value?.description) sections.push(readableText(value.description).replace(/^/gm, "> "));
    if (folder.kind === "group" || folder.kind === "feature") {
      if (!value) sections.push("제품 원문에서 이 항목을 찾지 못했습니다. 이전에 만든 폴더를 그대로 둡니다.");
      sections.push(...narrativeSections(folder.kind === "group" ? "FeatureGroup" : "Feature", folder.entityKey));
    }
    if (folder.kind === "product") sections.push(...narrativeSections("product-view", "project"));
    const parents = parentsLine(folder);
    if (parents) sections.push(parents);
    if (folder.kind === "feature") {
      const related = relatedConditions(folder);
      if (related) sections.push(related);
    }
    if (["product", "group", "conditions"].includes(folder.kind)) sections.push((regions.children = childrenRegion(folder)));
    if (["feature", "unclassified"].includes(folder.kind)) sections.push((regions.results = resultsRegion(folder)));
    if (folder.kind === "records")
      sections.push(
        (regions.records = extras.records ? recordsRegion(extras.records) : (doc.regions?.records ?? "## 작업 목록\n\n아직 선택한 작업 기록이 없습니다.")),
      );
    sections.push(`---\n\n${anchor(doc, state.documents["ev:" + folderKey], "근거 문서")}`);
    return { text: sections.join("\n\n") + "\n", regions };
  };
  const management = (lines) =>
    `## 관리 정보\n\n${[NOTICE, ...lines, `문서 규칙 버전: ${WORK_DOCUMENT_RENDERER}`, `배치 방식 버전: ${DOCUMENT_LAYOUT_VERSION}`].map((value) => `- ${value}`).join("\n")}`;
  const renderFolderEvidence = (folderKey) => {
    const folder = state.folders[folderKey],
      doc = state.documents["ev:" + folderKey],
      value = entity(folder.kind, folder.entityKey);
    const lines = [
      `사람용 문서: ${identity("doc:" + folderKey)}`,
      `근거 문서: ${identity("ev:" + folderKey)}`,
      `프로젝트: ${owner.projectId}`,
      `대상: ${folder.kind}${folder.entityKey ? ` ${folder.entityKey}` : ""}`,
      `폴더: ${folderDir(folder)}`,
      `제품 원문: ${canonRead.status} · ${canon.productModelId || "없음"} · ${canon.productModelHash || "없음"} · ${canonRead.sourceDigest || "없음"}`,
    ];
    const narrativeKey =
      (folder.kind === "group" ? "FeatureGroup" : folder.kind === "feature" ? "Feature" : "product-view") + "/" + (folder.entityKey || "project");
    const narrative = extras.narratives.get(narrativeKey) || state.narratives?.[narrativeKey];
    const sections = [`# ${line(displayName(folder))} 근거`, management(lines)];
    if (value) sections.push("## 제품 원문 항목\n\n" + "```json\n" + JSON.stringify(value, null, 2) + "\n```");
    if (narrative)
      sections.push(
        "## 읽기 설명의 출처\n\n" + "```json\n" + JSON.stringify({ sourceKeys: narrative.sourceKeys, attribution: narrative.attribution }, null, 2) + "\n```",
      );
    sections.push(anchor(doc, folderDoc(folderKey), "사람용 문서"));
    return { text: sections.join("\n\n") + "\n" };
  };

  // ---- folders ----
  const canonicalParents = (folder) =>
    folder.kind === "group" || folder.kind === "feature" ? parentKeys(folder.kind, folder.entityKey).map((groupKey) => "group:" + groupKey) : [];
  const linkedParents = (folder) => [...new Set([...(folder.parent ? [folder.parent] : []), ...canonicalParents(folder).filter((key) => state.folders[key])])];
  // A folder is created with its documents; every canonical parent is created
  // too (where it is placed), so a second parent or a flattened ancestor can
  // link to it.
  const ensuring = new Set();
  const ensureFolder = async (folderKey) => {
    const folder = ensurePlaced(folderKey);
    if (folder.created || ensuring.has(folderKey)) return folder;
    ensuring.add(folderKey);
    try {
      if (folder.parent) await ensureFolder(folder.parent);
      await create("doc:" + folderKey, () => renderFolder(folderKey));
      if (notion) await create("box:" + folderKey, () => ({ text: "# 근거\n\n이 폴더 문서들의 에이전트용 근거 문서가 이 아래에 있습니다.\n" }));
      await create("ev:" + folderKey, () => renderFolderEvidence(folderKey));
      for (const parentKey of canonicalParents(folder)) await ensureFolder(parentKey);
      // The parent links (상위) and the 근거 link are final only now.
      const whole = renderFolder(folderKey);
      if (whole.text !== folderDoc(folderKey).lastWritten) await refresh("doc:" + folderKey, { whole });
      for (const parentKey of linkedParents(folder))
        if (folderDoc(parentKey)?.id) await refresh("doc:" + parentKey, { regions: { children: childrenRegion(state.folders[parentKey]) } });
      folder.created = true;
      save();
    } finally {
      ensuring.delete(folderKey);
    }
    return folder;
  };

  // Brings a folder document and its ancestors up to the current model: names,
  // parent links and lists. Unchanged documents are not read or written.
  const syncChain = async (folderKey, seen = new Set()) => {
    if (seen.has(folderKey)) return;
    seen.add(folderKey);
    const folder = await ensureFolder(folderKey);
    for (const parentKey of [...new Set([folder.parent, ...canonicalParents(folder)].filter(Boolean))]) await syncChain(parentKey, seen);
    const whole = renderFolder(folderKey);
    if (whole.text !== folderDoc(folderKey).lastWritten || folderDoc(folderKey).edited) await refresh("doc:" + folderKey, { whole });
  };

  // ---- results ----
  const resolveFeatures = (featureKeys = []) => {
    const accepted = [],
      rejected = [];
    for (const featureKey of [...new Set(featureKeys)]) (canon.features.some((value) => value.key === featureKey) ? accepted : rejected).push(featureKey);
    return { accepted, rejected };
  };
  const publishResult = async ({ prepared, featureKeys = [], oldLayout = null }) => {
    await settlePending();
    await listRoot();
    const { basis, views } = prepared;
    const human = views.find((view) => view.audience === "human"),
      agent = views.find((view) => view.audience === "agent");
    const resultKey = hash([basis.logicalKey, basis.basisId]);
    let result = state.results[resultKey];
    let featureChangeIgnored = null;
    if (result) {
      const requested = resolveFeatures(featureKeys);
      if (JSON.stringify(requested.accepted) !== JSON.stringify(result.features))
        featureChangeIgnored = {
          requested: featureKeys,
          kept: result.features,
          reason: "this result is already published; the next result follows the new choice",
        };
    }
    if (!result) {
      const { accepted, rejected } = resolveFeatures(featureKeys);
      // Keys that are not Product features are never accepted as features.
      const folderKey = accepted.length ? "feature:" + accepted[0] : "unclassified";
      await ensureFolder(folderKey);
      const folder = state.folders[folderKey];
      const history = state.tasks[basis.logicalKey] || [];
      const number = history.length + 1;
      const title = human.title;
      const base = `${readableName(title, "작업")} 결과 ${number}`;
      const name = allocate(folder.files, "result:" + resultKey, base, folderDir(folder), ".md", (candidate) => Boolean(folder.dirs[lower(candidate + ".md")]));
      const evidenceName = allocate(folder.evidenceFiles, "result-ev:" + resultKey, name + " 근거", folderDir(folder) + "/근거", ".md");
      const record = basis.records.find((value) => value.role === "selected-task" && value.currentness !== "selected-historical-task-revision");
      const task = basis.taskState?.items.find((value) => value.todoId === basis.todoId);
      result = {
        key: resultKey,
        logicalKey: basis.logicalKey,
        basisId: basis.basisId,
        projectionId: prepared.projectionId,
        number,
        title,
        name,
        folder: folderKey,
        features: accepted,
        rejectedFeatureKeys: rejected,
        status: task?.status || record?.content.todos?.find((value) => value.todoId === basis.todoId)?.status || null,
        recordedAt:
          basis.records
            .filter((value) => value.role === "selected-task")
            .map((value) => value.recordedAt)
            .sort()
            .at(-1) || null,
        previous: history.length ? { kind: "tree", resultKey: history.at(-1) } : oldLayout ? { kind: "old-layout", ...oldLayout } : null,
        sequence: ++state.sequence,
      };
      state.results[resultKey] = result;
      state.tasks[basis.logicalKey] = [...history, resultKey];
      declare("result:" + resultKey, { folder: folderKey, role: "result", name });
      declare("result-ev:" + resultKey, { folder: folderKey, role: "evidence", name: evidenceName });
      save();
    }
    for (const featureKey of result.features) await ensureFolder("feature:" + featureKey);
    await ensureFolder(result.folder);
    const humanDoc = state.documents["result:" + resultKey],
      evidenceDoc = state.documents["result-ev:" + resultKey];
    const previousLink = (from) => {
      if (!result.previous) return null;
      if (result.previous.kind === "tree") {
        const doc = state.documents["result:" + result.previous.resultKey];
        return doc?.id ? anchor(from, doc, "이전 결과") : null;
      }
      if (notion) return result.previous.url ? `[이전 결과](${result.previous.url})` : null;
      const url = path.posix
        .relative(dirOf(from), result.previous.directory + "/" + result.previous.file)
        .split("/")
        .map(encodeLinkSegment)
        .join("/");
      return `[이전 결과](${url})`;
    };
    const previousName = () =>
      !result.previous
        ? "없음"
        : result.previous.kind === "tree"
          ? state.results[result.previous.resultKey]?.name || "이름 미확인"
          : `이전 방식 문서 ${result.previous.file || result.previous.url}`;
    const renderEvidence = () => ({
      text:
        [
          `# ${line(result.title)} — 결과 ${result.number} 근거`,
          management([
            `사람용 문서: ${identity("result:" + resultKey)}`,
            `근거 문서: ${identity("result-ev:" + resultKey)}`,
            `프로젝트: ${basis.projectId}`,
            `세션: ${basis.sessionId}`,
            `작업: ${basis.todoId || basis.selection.taskEvidenceId}`,
            `결과 번호: ${result.number}`,
            `근거 기록: ${basis.records
              .filter((value) => value.role === "selected-task")
              .map((value) => `${value.evidenceId} · ${value.evidenceDigest}`)
              .join(", ")}`,
            `기준 해시: ${basis.basisId}`,
            `읽기 뷰: ${human.viewId} / ${agent.viewId}`,
            `이전 결과: ${previousName()}`,
            `기능 지정: ${result.features.join(", ") || "없음"}${result.rejectedFeatureKeys.length ? ` · 받지 않은 기능 이름: ${result.rejectedFeatureKeys.join(", ")}` : ""}`,
          ]),
          agent.markdown.trimEnd(),
          anchor(evidenceDoc, humanDoc, "사람용 문서"),
        ].join("\n\n") + "\n",
    });
    const renderHuman = () => {
      const links = [previousLink(humanDoc)].filter(Boolean);
      for (const featureKey of result.features) {
        const folder = state.folders["feature:" + featureKey];
        links.push(anchor(humanDoc, folderDoc(folder.key), `기능: ${displayName(folder)}`));
      }
      if (!result.features.length) links.push(anchor(humanDoc, folderDoc("unclassified"), "소속 미확인"));
      links.push(anchor(humanDoc, evidenceDoc, "근거 문서"));
      return { text: `# ${line(result.title)} — 결과 ${result.number}\n\n${human.markdown.trimEnd()}\n\n---\n\n${links.join(" · ")}\n` };
    };
    // The evidence document is created first so the human document is written
    // once with its final links.
    await create("result-ev:" + resultKey, renderEvidence);
    await create("result:" + resultKey, renderHuman);
    if (evidenceDoc.createText.includes("(연결 준비 중)")) await refresh("result-ev:" + resultKey, { whole: renderEvidence() });
    // Readback of an existing result: a person's edit is reported, not replaced.
    const observed = await writerFor(humanDoc).readBound(humanDoc.id);
    const humanCurrent = observed.complete && !observed.warnings?.length && sameDocumentText(observed.markdown, humanDoc.lastWritten);
    if (!humanCurrent) note({ document: humanDoc.name, status: "person-edited-not-overwritten" }, humanDoc.key);
    const folders = [...new Set([result.folder, ...result.features.map((featureKey) => "feature:" + featureKey)])];
    const seen = new Set();
    for (const folderKey of folders) await syncChain(folderKey, seen);
    let oldLayoutLink = null;
    if (result.previous?.kind === "old-layout") oldLayoutLink = await linkOldLayout(result, humanDoc);
    return {
      result,
      humanDoc,
      evidenceDoc,
      humanCurrent,
      oldLayoutLink,
      featureChangeIgnored,
      url: (doc) => (notion ? adapter.url(doc.id) : dirOf(doc) + "/" + doc.name + ".md"),
    };
  };
  // Once per task: the old Start document's Lode list region points to the new
  // location. A person's edit there is skipped and reported.
  const linkOldLayout = async (result, humanDoc) => {
    const prior = state.oldLayout[result.logicalKey];
    if (prior) return prior;
    const old = result.previous;
    const where = notion ? adapter : createObsidianWorkDocumentAdapter({ vaultRoot: vault, directory: old.directory });
    const doc = { key: "old-start:" + result.logicalKey, id: old.startId };
    const writer = createDocumentEffectWriter({
      store,
      adapter: where,
      key: hash([key, doc.key]),
      target: { id: key },
      configurationDigest: permissionDigest,
      prepared: { projectionId: hash([key, "readable-document-tree"]) },
      previous: null,
      recordInputs: true,
    });
    let outcome;
    try {
      if (!old.startId || typeof old.currentText !== "string" || !old.currentText) throw Object.assign(new Error("No old list region."), { code: "ENOENT" });
      const observed = await writer.readBound(old.startId);
      const url = notion
        ? adapter.url(humanDoc.id)
        : path.posix
            .relative(old.directory, dirOf(humanDoc) + "/" + humanDoc.name + ".md")
            .split("/")
            .map(encodeLinkSegment)
            .join("/");
      const text = `이후 결과는 새 위치에 있습니다: [${line(humanDoc.name)}](${url})`;
      const applied = observed.markdown.split(text).length === 2 && !observed.markdown.includes(old.currentText);
      if (!observed.complete || observed.warnings?.length || (!applied && observed.markdown.split(old.currentText).length !== 2))
        outcome = { status: "person-edited-not-overwritten", document: old.startName };
      else {
        await writer.change(old.startId, old.currentText, text);
        outcome = { status: "linked-to-new-location", document: old.startName };
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.httpStatus !== 404 && !error.pageMissing) throw error;
      outcome = { status: "old-start-document-missing", document: old.startName };
    }
    state.oldLayout[result.logicalKey] = outcome;
    save();
    if (outcome.status === "person-edited-not-overwritten") note(outcome, "old-start:" + result.logicalKey);
    return outcome;
  };

  // ---- Product documents (Project publication) ----
  const entityDisplay = (kind, value) => value?.name || value?.statement || value?.key;
  const ensureEntity = async (kind, entityKey) => {
    await ensureFolder("conditions");
    const folder = state.folders.conditions;
    const docKey = `entity:${kind}:${entityKey}`;
    if (!state.documents[docKey]) {
      const value = (canon[ENTITY_FIELDS[kind][0]] || []).find((item) => item.key === entityKey);
      const name = allocate(folder.files, docKey, readableName(entityDisplay(kind, value)), folderDir(folder), ".md", (candidate) =>
        Boolean(folder.dirs[lower(candidate + ".md")]),
      );
      const evidence = allocate(folder.evidenceFiles, docKey + ":ev", name + " 근거", folderDir(folder) + "/근거", ".md");
      declare(docKey, { folder: "conditions", role: "entity", entityKind: kind, entityKey, name });
      declare(docKey + ":ev", { folder: "conditions", role: "evidence", name: evidence });
      save();
    }
    await create(docKey + ":ev", () => renderEntityEvidence(kind, entityKey));
    await create(docKey, () => renderEntity(kind, entityKey));
    const evidence = state.documents[docKey + ":ev"];
    if (evidence.createText.includes("(연결 준비 중)")) await refresh(docKey + ":ev", { whole: renderEntityEvidence(kind, entityKey) });
    await refresh("doc:conditions", { regions: { children: childrenRegion(folder) } });
    return state.documents[docKey];
  };
  const renderEntity = (kind, entityKey) => {
    const doc = state.documents[`entity:${kind}:${entityKey}`],
      value = (canon[ENTITY_FIELDS[kind][0]] || []).find((item) => item.key === entityKey);
    doc.display = entityDisplay(kind, value) || doc.name;
    const sections = [`# ${line(doc.display)}`, `종류: ${ENTITY_FIELDS[kind][1]}`];
    if (!value) sections.push("제품 원문에서 이 항목을 찾지 못했습니다.");
    const body = value?.statement || value?.description;
    if (body && body !== doc.display) sections.push(readableText(body).replace(/^/gm, "> "));
    sections.push(...narrativeSections(kind, entityKey));
    sections.push(`상위: ${anchor(doc, folderDoc("conditions"), SPECIAL.conditions.name)}`);
    const features = canon.features.filter(
      (feature) =>
        feature.governedBy?.some((ref) => ref.kind === kind && ref.key === entityKey) ||
        (kind === "Capability" && feature.capabilityKeys?.includes(entityKey)) ||
        (kind === "Policy" && value?.appliesTo?.some((ref) => ref.kind === "Feature" && ref.key === feature.key)),
    );
    if (features.length)
      sections.push(
        "## 관련 기능\n\n" +
          features
            .map((feature) => {
              const folder = state.folders["feature:" + feature.key];
              return `- ${folder && folderDoc(folder.key)?.id ? anchor(doc, folderDoc(folder.key), feature.name) : line(feature.name)}`;
            })
            .join("\n"),
      );
    sections.push(`---\n\n${anchor(doc, state.documents[`entity:${kind}:${entityKey}:ev`], "근거 문서")}`);
    return { text: sections.join("\n\n") + "\n" };
  };
  const renderEntityEvidence = (kind, entityKey) => {
    const docKey = `entity:${kind}:${entityKey}`,
      value = (canon[ENTITY_FIELDS[kind][0]] || []).find((item) => item.key === entityKey);
    return {
      text:
        [
          `# ${line(state.documents[docKey].display || state.documents[docKey].name)} 근거`,
          management([
            `사람용 문서: ${identity(docKey)}`,
            `근거 문서: ${identity(docKey + ":ev")}`,
            `프로젝트: ${owner.projectId}`,
            `대상: ${kind} ${entityKey}`,
            `제품 원문: ${canonRead.status} · ${canon.productModelId || "없음"} · ${canon.productModelHash || "없음"} · ${canonRead.sourceDigest || "없음"}`,
          ]),
          ...(value ? ["## 제품 원문 항목\n\n```json\n" + JSON.stringify(value, null, 2) + "\n```"] : []),
          anchor(state.documents[docKey + ":ev"], state.documents[docKey], "사람용 문서"),
        ].join("\n\n") + "\n",
    };
  };
  // Ordered steps for one full Project publication: entities first so feature
  // documents can link to them, then the folder tree from the product down.
  const projectSteps = ({ records }) => {
    const steps = [{ kind: "folder", key: "product" }];
    for (const [kind, [field]] of Object.entries(ENTITY_FIELDS))
      for (const value of canon[field] || []) steps.push({ kind: "entity", entityKind: kind, key: value.key });
    const depth = (group, seen = new Set()) => {
      if (seen.has(group.key)) return 0;
      seen.add(group.key);
      const parent = canon.featureGroups.find((value) => value.key === group.parentFeatureGroupKeys?.[0]);
      return parent ? depth(parent, seen) + 1 : 0;
    };
    for (const group of [...canon.featureGroups].sort((a, b) => depth(a) - depth(b) || a.key.localeCompare(b.key)))
      steps.push({ kind: "folder", key: "group:" + group.key });
    for (const feature of [...canon.features].sort((a, b) => a.key.localeCompare(b.key))) steps.push({ kind: "folder", key: "feature:" + feature.key });
    steps.push({ kind: "folder", key: "unclassified" });
    if (records) steps.push({ kind: "folder", key: "records" });
    for (const [kind, [field]] of Object.entries(ENTITY_FIELDS))
      for (const value of canon[field] || []) steps.push({ kind: "entity", entityKind: kind, key: value.key });
    steps.push({ kind: "folder", key: "product", final: true });
    return steps;
  };
  const runProjectStep = async (step, { multiCall = false, projectionId = null } = {}) => {
    await settlePending();
    await listRoot();
    // A publication spanning several calls owns the line until its last step; a
    // publication that completes replaces whatever an earlier one left.
    const inProgress = multiCall && !step.final ? projectionId || true : false;
    if (state.inProgress !== inProgress) {
      state.inProgress = inProgress;
      save();
    }
    if (step.kind === "entity") {
      await ensureEntity(step.entityKind, step.key);
      const docKey = `entity:${step.entityKind}:${step.key}`;
      await refresh(docKey, { whole: renderEntity(step.entityKind, step.key) });
      await refresh(docKey + ":ev", { whole: renderEntityEvidence(step.entityKind, step.key) });
      return;
    }
    await ensureFolder(step.key);
    await refresh("doc:" + step.key, { whole: renderFolder(step.key) });
    await refresh("ev:" + step.key, { whole: renderFolderEvidence(step.key) });
  };
  recordsRegion = ({ works, readings }) => {
    const from = folderDoc("records");
    const blocks = [];
    for (const work of [...works].sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)) || a.key.localeCompare(b.key))) {
      const content = work.content;
      const featureLinks = work.featureKeys
        .map((featureKey) => state.folders["feature:" + featureKey])
        .filter((folder) => folder && folderDoc(folder.key)?.id)
        .map((folder) => anchor(from, folderDoc(folder.key), displayName(folder)));
      const parts = [
        `### ${line(content.summary || "작업 기록").slice(0, 120)}`,
        `기록 ${recordedTime(work.recordedAt)} · ${featureLinks.length ? `기능: ${featureLinks.join(", ")}` : "소속 미확인"}`,
      ];
      for (const [field, label] of [
        ["observedWork", "한 일"],
        ["pending", "남은 일"],
        ["unknowns", "확인하지 못한 것"],
      ])
        if (content[field]?.length) parts.push(`${label}\n\n${content[field].map((value) => `- ${readableText(value).split("\n").join("\n  ")}`).join("\n")}`);
      blocks.push(parts.join("\n\n"));
    }
    const resultLines = readings.map((reading) => {
      const latest = (state.tasks[reading.logicalKey] || []).at(-1);
      const doc = latest && state.documents["result:" + latest];
      return doc?.id ? `- ${anchor(from, doc, state.results[latest].name)}` : `- ${line(reading.title)} — 결과 문서는 아직 게시되지 않았습니다.`;
    });
    return (
      "## 작업 목록\n\n" +
      (blocks.length ? blocks.join("\n\n") : "아직 선택한 작업 기록이 없습니다.") +
      (resultLines.length ? `\n\n### 결과 문서\n\n${resultLines.join("\n")}` : "")
    );
  };

  return {
    get state() {
      return state;
    },
    report,
    canonRead,
    notion,
    resolveFeatures,
    publishResult,
    projectSteps,
    runProjectStep,
    // The publication that set the in-progress line can no longer finish (its
    // source, selection or destination changed): the line is removed, so a
    // person is never told an update is running when none is.
    async endProgress(projectionId) {
      if (!state.inProgress || state.inProgress !== projectionId || !folderDoc("product")?.id) return;
      state.inProgress = false;
      save();
      await refresh("doc:product", { whole: renderFolder("product"), skipCheck: true });
    },
    setExtras(value) {
      extras = { ...extras, ...value };
      if (value.narratives) {
        state.narratives = Object.fromEntries(value.narratives);
        state.narrativesModelHash = canon.productModelHash;
        save();
      }
    },
    folderDoc,
    url: (doc) => (notion ? adapter.url(doc.id) : dirOf(doc) + "/" + doc.name + ".md"),
    reload() {
      state = readDocumentTree(store, key) || state;
    },
  };
}
