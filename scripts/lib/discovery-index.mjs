import crypto from "node:crypto";
import { formatForVerifiedOwner, relativeProjectArtifact, resolveProjectStorage, projectLocationBasis } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteArtifact } from "./artifact-storage.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { sessionWorkPath, createSessionWorkReadContext, normalizeSessionWorkEvidence,
  verifySessionWorkEvidenceOwner, verifySessionWorkEvidenceOriginal,
  MAX_RECORD_BYTES, MAX_REFERENCE_BYTES, sessionTodoDeclarations } from "./session-work-evidence-original.mjs";

// A replaceable inventory of original records, not a second record store. No
// bodies, decisions, credentials or provider handles are copied into the index.
export const PROJECT_GRAPH_INDEX_PATH = ".head/graph-discovery/index.json";
export const PROJECT_GRAPH_RECORD_DIRECTORIES = Object.freeze([
  ".head/observations", ".head/lineage", ".head/onboarding/candidate-sets",
  ".head/onboarding/review-decisions", ".head/onboarding/product-model-revisions",
  ".head/product-policy", ".head/change-sets", ".head/release-observations",
  ".head/conformance", ".head/sessions/records", ".head/sessions/by-id",
  ".head/sessions/ledger", ".head/sessions/runs", ".head/project-direction/revisions", ".head/sessions/work-evidence",
]);
const singletonPaths = [".head/context/product-model.json", ".head/world-model/current.json",
  ".head/sessions/current.json", ".head/project-direction/current.json"];
export const projectGraphIndexPath = owner => relativeProjectArtifact(owner, "graph-discovery", "index.json");
export const projectGraphRecordDirectories = owner => PROJECT_GRAPH_RECORD_DIRECTORIES.map(relative => relativeProjectArtifact(owner, relative.slice(6)));
const ownedPaths = (paths, owner) => paths.map(relative => relativeProjectArtifact(owner, relative.slice(6)));
const MAX_RECORDS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 128 * 1024 * 1024;
// These are reader inputs, not additional semantic nodes. Include directory
// shape as well as bytes: an empty/unexpected directory or non-JSON file can
// invalidate the historical reader without changing any ordinary record.
const ONBOARDING_READER_DIRECTORIES = [
  ".head/onboarding/historical-boundaries", ".head/onboarding/historical-continuity",
  ".head/onboarding/candidate-sets", ".head/onboarding/review-decisions",
  ".head/onboarding/product-model-revisions",
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export function canonicalGraphJson(value) {
  const sort = (entry) => Array.isArray(entry) ? entry.map(sort) : entry && typeof entry === "object"
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])])) : entry;
  return JSON.stringify(sort(value));
}
export const projectGraphDigest = (value) => hash(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalGraphJson(value));
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

export function safeGraphFile(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("PROJECT_GRAPH_PATH_ESCAPE");
  const target = path.resolve(root, relative);
  if (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target))) fail("PROJECT_GRAPH_PATH_ESCAPE");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("PROJECT_GRAPH_SYMLINK_PATH");
  }
  return target;
}

export function readGraphProject(root) {
  const projectRoot = fs.realpathSync(path.resolve(root));
  const storage = resolveProjectStorage(projectRoot, { readLegacyProject() {
    const legacyFile = safeGraphFile(projectRoot, ".head/project.json");
    const project = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (project.schemaVersion !== 1 || project.projectRoot !== projectRoot || !/^head-[a-f0-9]{20}$/.test(project.projectId || "")) fail("PROJECT_IDENTITY_MISMATCH");
    return project;
  } });
  if (!storage) return { projectRoot, project: null, storage: null };
  const file = safeGraphFile(projectRoot, relativeProjectArtifact(storage, "project.json"));
  const project = JSON.parse(fs.readFileSync(file, "utf8"));
  if (project.schemaVersion !== 1 || project.projectRoot !== projectRoot || !new RegExp(`^${formatForVerifiedOwner(storage).projectPrefix}[a-f0-9]{20}$`).test(project.projectId || "")) fail("PROJECT_IDENTITY_MISMATCH");
  return { projectRoot, project, storage };
}

export function readGraphRecord(root, relative, maximum = MAX_BYTES) {
  const file = safeGraphFile(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maximum) fail("PROJECT_GRAPH_RECORD_LIMIT");
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximum) fail("PROJECT_GRAPH_RECORD_LIMIT");
  return { document: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes, digest: hash(bytes) };
}

// Optional historical headers, never current validity, direction or bodies.
// Missing/legacy/malformed rows remain unknowns in the same reader request.
function navigationRows(index) {
  const navigation = index.sessionWorkNavigation;
  if (navigation?.version !== 1 || !Array.isArray(navigation.rows) || navigation.rows.length > MAX_RECORDS) return new Map();
  const entries = new Map(index.entries.map(entry => [entry.path, entry]));
  const unavailable = new Set([...(index.unavailable || []), ...(index.readerDependencies?.sessionWork?.unavailable || [])].map(entry => entry.path));
  const rows = new Map(), seen = new Set();
  for (const row of navigation.rows) {
    if (seen.has(row?.path)) return new Map();
    seen.add(row?.path);
    const selector = sessionWorkPath(row?.path);
    if (!selector || Object.keys(row).length !== 5 || !["path", "rawDigest", "ownerSessionId", "recordedAt", "observationTargetId"].every(key => Object.hasOwn(row, key))
      || !/^session-[a-fA-F0-9-]{36}$/.test(row.ownerSessionId || "") || selector.sessionId && selector.sessionId !== row.ownerSessionId
      || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt))
      || row.observationTargetId !== null && !/^work-evidence-[a-f0-9]{24}$/.test(row.observationTargetId || "")
      || !/^[a-f0-9]{64}$/.test(row.rawDigest || "") || entries.get(row.path)?.sha256 !== row.rawDigest
      || unavailable.has(row.path) || unavailable.has(selector.statePath)) continue;
    rows.set(row.path, row);
  }
  return rows;
}

function buildSessionWorkNavigation(root, entries, context, bytesByPath = new Map(), storage = null) {
  const owners = new Map(), rows = [], todoRows = [];
  for (const entry of entries) {
    const selector = sessionWorkPath(entry.path);
    if (!selector) continue;
    try {
      if (!owners.has(selector.statePath)) {
        try { owners.set(selector.statePath, verifySessionWorkEvidenceOwner({ root,
          storage, projectBytes: context.read(relativeProjectArtifact(storage, "project.json"), MAX_REFERENCE_BYTES), stateBytes: context.read(selector.statePath, MAX_REFERENCE_BYTES) })); }
        catch { owners.set(selector.statePath, null); }
      }
      const owner = owners.get(selector.statePath);
      if (!owner || selector.sessionId && owner.sessionId !== selector.sessionId) continue;
      const bytes = bytesByPath.get(entry.path) || context.read(entry.path, MAX_RECORD_BYTES);
      if (hash(bytes) !== entry.sha256) continue;
      const original = verifySessionWorkEvidenceOriginal({ owner, evidenceId: selector.evidenceId, bytes });
      rows.push({ path: entry.path, rawDigest: entry.sha256, ownerSessionId: owner.sessionId, recordedAt: original.recordedAt,
        observationTargetId: original.content.executionObservation?.target?.evidenceId || null });
      if (original.content.todos?.length) todoRows.push({ path: entry.path, rawDigest: entry.sha256, ownerSessionId: owner.sessionId, evidenceDigest: original.evidenceDigest,
        todoRevisions: sessionTodoDeclarations(original.content) });
    } catch { /* A missing header is not a stored negative verdict. */ }
  }
  return { version: 1, rows, todoRows };
}

function todoNavigationRows(index) {
  const navigation = index.sessionTodoNavigation;
  if (navigation?.version !== 1 || !Array.isArray(navigation.rows) || navigation.rows.length > MAX_RECORDS) return new Map();
  const entries = new Map(index.entries.map(entry => [entry.path, entry])), rows = new Map();
  const exact = value => /^work-evidence-[a-f0-9]{24}$/.test(value?.evidenceId || "") && /^[a-f0-9]{64}$/.test(value?.evidenceDigest || "");
  for (const row of navigation.rows) {
    const selector = sessionWorkPath(row?.path);
    if (!selector || rows.has(row.path) || Object.keys(row).length !== 5
      || !/^session-[a-fA-F0-9-]{36}$/.test(row.ownerSessionId || "") || selector.sessionId && selector.sessionId !== row.ownerSessionId
      || !/^[a-f0-9]{64}$/.test(row.evidenceDigest || "") || entries.get(row.path)?.sha256 !== row.rawDigest
      || !Array.isArray(row.todoRevisions) || !row.todoRevisions.length || row.todoRevisions.some(todo =>
        !/^todo-[a-z0-9][a-z0-9-]{0,79}$/.test(todo?.todoId || "") || !["pending", "partial", "waiting", "completed", "cancelled"].includes(todo.status)
        || todo.prior !== undefined && !exact(todo.prior) || todo.resolves !== undefined && (!Array.isArray(todo.resolves) || todo.resolves.some(value => !exact(value))))) continue;
    rows.set(row.path, row);
  }
  return rows;
}

// Internal cross-module optimization only. Validates stored metadata, not the
// current originals. No inventory refresh, other Session reads or write/repair.
export function readSessionWorkNavigationHints(owner, regularFileIds, context = null) {
  try {
    const index = readGraphRecord(owner.root, projectGraphIndexPath(owner.storage)).document;
    if (index.kind !== "ProjectGraphRecordIndex" || index.version !== 1 || index.projectId !== owner.projectId
      || index.rootDigest !== hash(owner.root) || index.authority !== "P4-replaceable-record-inventory"
      || index.instructionAuthority !== false || index.promotionAuthority !== false || index.recoveryAuthority !== false
      || typeof index.complete !== "boolean" || !Array.isArray(index.entries) || index.entries.length > MAX_RECORDS || !Array.isArray(index.unavailable)) return new Map();
    verifyArtifactAuthorityBoundary("ProjectGraphRecordIndex", index.authorityBoundary);
    const paths = new Set();
    for (const entry of index.entries) {
      if (typeof entry.path !== "string" || !entry.path.startsWith(`${formatForVerifiedOwner(owner.storage).directory}/`) || entry.path.includes("\\")
        || entry.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(entry.path)
        || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return new Map();
      paths.add(entry.path);
    }
    if (index.recordsDigest !== projectGraphDigest({ projectId: owner.projectId, projectRoot: owner.root,
      entries: index.entries, unavailable: index.unavailable, complete: index.complete, readerDependencies: index.readerDependencies })) return new Map();
    const selectedRows = rows => new Map([...rows.values()].filter(row => {
      const selector = sessionWorkPath(row.path);
      return selector.directory === owner.workDirectory && row.ownerSessionId === owner.sessionId && regularFileIds.has(selector.evidenceId);
    }).map(row => [sessionWorkPath(row.path).evidenceId, row]));
    if (context) context.todoHints = selectedRows(todoNavigationRows(index));
    return selectedRows(navigationRows(index));
  } catch { return new Map(); }
}

// Exact reader dependencies, not semantic nodes. Absence is an observation
// whose later appearance invalidates a proof; malformed work stays local.
function sessionWorkDependencies(root, entries, context, storage, recordLimit = MAX_RECORDS) {
  const dependencies = { version: 1, entries: [], layout: [], unavailable: [], complete: true };
  const seen = new Set(); let total = 0;
  const add = (relative, maximum = MAX_REFERENCE_BYTES) => {
    if (seen.has(relative)) return;
    seen.add(relative);
    if (seen.size > recordLimit) { dependencies.complete = false; return; }
    try {
      const file = safeGraphFile(root, relative);
      if (!fs.existsSync(file)) { dependencies.layout.push({ path: relative, type: "absent" }); return; }
      const bytes = context.read(relative, maximum);
      if (total + bytes.length > MAX_INVENTORY_BYTES) { dependencies.complete = false; return; }
      total += bytes.length;
      dependencies.entries.push({ path: relative, sha256: hash(bytes), bytes: bytes.length });
      dependencies.layout.push({ path: relative, type: "file" });
    } catch (error) { dependencies.unavailable.push({ path: relative, reasonCode: error.code || "PROJECT_GRAPH_DEPENDENCY_UNAVAILABLE" }); }
  };
  for (const entry of entries) {
    const selector = sessionWorkPath(entry.path);
    if (!selector) continue;
    add(selector.statePath); add(relativeProjectArtifact(storage, "sessions/current.json"));
    try {
      const content = JSON.parse(context.read(entry.path, MAX_RECORD_BYTES)).content;
      const normalized = normalizeSessionWorkEvidence(Object.fromEntries(Object.entries(content || {}).filter(([, v]) => v !== null)));
      for (const exact of [normalized.workLink?.root, normalized.workLink?.predecessor, normalized.executionObservation?.target,
        ...(normalized.todos || []).flatMap(todo => [todo.prior, ...(todo.resolves || []), ...(todo.relatedEvidence || [])])].filter(Boolean)) {
        add(`${selector.directory}/${exact.evidenceId}.json`, MAX_RECORD_BYTES);
      }
      for (const ref of normalized.references) {
        add(ref.path);
        const work = ref.kind === "artifact" && sessionWorkPath(ref.path);
        if (work) { add(work.statePath); add(relativeProjectArtifact(storage, "sessions/current.json")); }
      }
    } catch { /* Typed verifier reports this original only; its bytes remain in proof. */ }
  }
  for (const field of ["entries", "layout", "unavailable"]) dependencies[field].sort((a, b) => a.path.localeCompare(b.path));
  return dependencies;
}

export function collectProjectGraphInventory(root, { recordLimit = MAX_RECORDS } = {}) {
  const { projectRoot, project, storage } = readGraphProject(root);
  if (!project) return { projectRoot, project, entries: [], unavailable: [], complete: false, recordsDigest: null };
  const entries = [], unavailable = [], workContext = createSessionWorkReadContext(projectRoot, storage);
  let complete = true, examinedBytes = 0;
  const add = (relative) => {
    if (relative.startsWith(relativeProjectArtifact(storage, "sessions/by-id/")) && !new RegExp(`^\\${formatForVerifiedOwner(storage).directory}/sessions/by-id/session-[a-fA-F0-9-]{36}/current\\.json$`).test(relative) && !sessionWorkPath(relative)) return;
    if (relative.startsWith(relativeProjectArtifact(storage, "sessions/work-evidence/")) && !sessionWorkPath(relative)) return;
    if (relative.startsWith(relativeProjectArtifact(storage, "sessions/runs/")) && !relative.endsWith("/run.json")) return;
    if (entries.length >= recordLimit) { complete = false; return; }
    try {
      const file = safeGraphFile(projectRoot, relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) fail("PROJECT_GRAPH_RECORD_LIMIT");
      if (examinedBytes + stat.size > MAX_INVENTORY_BYTES) { complete = false; return; }
      examinedBytes += stat.size;
      // Byte hashing, never mtime alone, detects tampering even on unchanged
      // stat metadata. Unchanged records reuse verification/analysis later.
      const bytes = sessionWorkPath(relative) ? workContext.read(relative, MAX_RECORD_BYTES) : fs.readFileSync(file);
      entries.push({ path: relative, sha256: hash(bytes), bytes: bytes.length });
    } catch (error) { unavailable.push({ path: relative, reasonCode: error.code || "PROJECT_GRAPH_RECORD_UNAVAILABLE" }); }
  };
  const visit = (relative, depth = 0) => {
    if (entries.length >= recordLimit || depth > 8) { complete = false; return; }
    try {
      const directory = safeGraphFile(projectRoot, relative);
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) { unavailable.push({ path: `${relative}/${entry.name}`, reasonCode: "PROJECT_GRAPH_SYMLINK_PATH" }); continue; }
        if (entry.isDirectory()) visit(`${relative}/${entry.name}`, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".json")) add(`${relative}/${entry.name}`);
      }
    } catch (error) { unavailable.push({ path: relative, reasonCode: error.code || "PROJECT_GRAPH_DIRECTORY_UNAVAILABLE" }); }
  };
  for (const directory of projectGraphRecordDirectories(storage)) visit(directory);
  for (const relative of ownedPaths(singletonPaths, storage)) {
    try { if (fs.existsSync(safeGraphFile(projectRoot, relative))) add(relative); }
    catch (error) { unavailable.push({ path: relative, reasonCode: error.code }); }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  unavailable.sort((a, b) => a.path.localeCompare(b.path));
  const dependencies = { entries: [], layout: [], unavailable: [], complete: true };
  const alreadyHashed = new Map(entries.map((entry) => [entry.path, entry]));
  let dependencyBytes = 0;
  const dependencyFile = (relative) => {
    if (dependencies.entries.some((entry) => entry.path === relative)) return;
    if (alreadyHashed.has(relative)) { dependencies.entries.push(alreadyHashed.get(relative)); return; }
    try {
      const file = safeGraphFile(projectRoot, relative), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES || dependencyBytes + stat.size > MAX_INVENTORY_BYTES
        || dependencies.entries.length >= recordLimit) fail("PROJECT_GRAPH_DEPENDENCY_LIMIT");
      dependencyBytes += stat.size;
      dependencies.entries.push({ path: relative, sha256: hash(fs.readFileSync(file)), bytes: stat.size });
    } catch (error) { dependencies.unavailable.push({ path: relative, reasonCode: error.code || "PROJECT_GRAPH_DEPENDENCY_UNAVAILABLE" }); }
  };
  const dependencyDirectory = (relative, depth = 0) => {
    if (depth > 8 || dependencies.layout.length >= recordLimit) { dependencies.complete = false; return; }
    try {
      const directory = safeGraphFile(projectRoot, relative);
      if (!fs.existsSync(directory)) { dependencies.layout.push({ path: relative, type: "absent" }); return; }
      if (!fs.lstatSync(directory).isDirectory()) fail("PROJECT_GRAPH_DEPENDENCY_DIRECTORY_INVALID");
      dependencies.layout.push({ path: relative, type: "directory" });
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (dependencies.layout.length >= recordLimit) { dependencies.complete = false; break; }
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) dependencyDirectory(child, depth + 1);
        else {
          dependencies.layout.push({ path: child, type: entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other" });
          if (entry.isFile()) dependencyFile(child);
        }
      }
    } catch (error) { dependencies.unavailable.push({ path: relative, reasonCode: error.code || "PROJECT_GRAPH_DEPENDENCY_UNAVAILABLE" }); }
  };
  for (const directory of ownedPaths(ONBOARDING_READER_DIRECTORIES, storage)) dependencyDirectory(directory);
  // A committed boundary also verifies exact retained World bytes. Read only
  // path references here; the authority-aware reader validates their meaning.
  for (const entry of [...dependencies.entries].filter((entry) => entry.path.endsWith("/boundary.json"))) {
    try {
      const document = readGraphRecord(projectRoot, entry.path).document;
      for (const reference of (Array.isArray(document.entries) ? document.entries : []).slice(0, 512)) {
        if (reference.role === "legacy-world-embedding-reference" && typeof reference.path === "string") dependencyFile(reference.path);
      }
    } catch { /* Malformed boundary is rejected by its original typed reader. */ }
  }
  for (const field of ["entries", "layout", "unavailable"]) dependencies[field].sort((a, b) => a.path.localeCompare(b.path));
  dependencies.projectLocation = projectLocationBasis(storage);
  const readerDependencies = { onboarding: dependencies, sessionWork: sessionWorkDependencies(projectRoot, entries, workContext, storage, recordLimit) };
  const recordsDigest = projectGraphDigest({ projectId: project.projectId, projectRoot, entries, unavailable, complete, readerDependencies });
  return { projectRoot, project, storage, entries, unavailable, complete, readerDependencies, recordsDigest, workContext };
}

export function refreshProjectGraphIndex({ root = "." } = {}) {
  const inventory = collectProjectGraphInventory(root);
  if (!inventory.project) return { status: "not-initialized", ordinaryWorkBlocked: false };
  const { todoRows, ...sessionWorkNavigation } = buildSessionWorkNavigation(inventory.projectRoot, inventory.entries, inventory.workContext, new Map(), inventory.storage);
  const payload = { kind: "ProjectGraphRecordIndex", version: 1, projectId: inventory.project.projectId,
    rootDigest: hash(inventory.projectRoot), recordsDigest: inventory.recordsDigest,
    entries: inventory.entries, unavailable: inventory.unavailable, complete: inventory.complete,
    readerDependencies: inventory.readerDependencies,
    sessionWorkNavigation, sessionTodoNavigation: { version: 1, rows: todoRows },
    authorityBoundary: artifactAuthorityBoundary("ProjectGraphRecordIndex"),
    authority: "P4-replaceable-record-inventory", instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false };
  return publishInventory(inventory.projectRoot, payload, inventory.storage);
}

function publishInventory(root, payload, storage) {
  const content = `${canonicalGraphJson(payload)}\n`;
  const indexPath = projectGraphIndexPath(storage);
  const file = safeGraphFile(root, indexPath);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return { status: "reused", indexPath, recordsDigest: payload.recordsDigest, recordCount: payload.entries.length, ordinaryWorkBlocked: false };
  atomicWriteArtifact(file, content);
  return { status: "indexed", indexPath, recordsDigest: payload.recordsDigest, recordCount: payload.entries.length, ordinaryWorkBlocked: false };
}

function updateProjectGraphIndex(root, changedPaths) {
  const { projectRoot, project, storage } = readGraphProject(root);
  if (!project) return { status: "not-initialized", ordinaryWorkBlocked: false };
  const indexFile = safeGraphFile(projectRoot, projectGraphIndexPath(storage));
  if (!fs.existsSync(indexFile)) return refreshProjectGraphIndex({ root });
  const previous = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  if ((previous.readerDependencies?.onboarding?.projectLocation ?? null) !== projectLocationBasis(storage)
    || !previous.readerDependencies?.sessionWork?.version || changedPaths.some((relative) => relative.startsWith(relativeProjectArtifact(storage, "onboarding/"))
    || relative.startsWith(relativeProjectArtifact(storage, "world-model/snapshots/")))) return refreshProjectGraphIndex({ root });
  if (previous.kind !== "ProjectGraphRecordIndex" || previous.version !== 1 || previous.projectId !== project.projectId
    || previous.rootDigest !== hash(projectRoot) || !Array.isArray(previous.entries) || previous.entries.length > MAX_RECORDS
    || !Array.isArray(previous.unavailable) || previous.authority !== "P4-replaceable-record-inventory"
    || previous.instructionAuthority !== false || previous.promotionAuthority !== false || previous.recoveryAuthority !== false
    || previous.entries.some((entry) => typeof entry.path !== "string" || entry.path.includes("..") || !entry.path.startsWith(`${formatForVerifiedOwner(storage).directory}/`)
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) return refreshProjectGraphIndex({ root });
  const entries = new Map(previous.entries.map((entry) => [entry.path, entry]));
  const changedBytes = new Map(), workContext = createSessionWorkReadContext(projectRoot, storage);
  const unavailable = previous.unavailable.filter((entry) => !changedPaths.includes(entry.path));
  for (const relative of changedPaths) {
    const target = safeGraphFile(projectRoot, relative);
    if (!fs.existsSync(target)) { entries.delete(relative); continue; }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_BYTES) { entries.delete(relative); unavailable.push({ path: relative, reasonCode: "PROJECT_GRAPH_RECORD_LIMIT" }); continue; }
    const bytes = fs.readFileSync(target);
    entries.set(relative, { path: relative, sha256: hash(bytes), bytes: stat.size });
    if (sessionWorkPath(relative)) changedBytes.set(relative, bytes);
  }
  const allEntries = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const complete = previous.complete && allEntries.length <= MAX_RECORDS;
  const boundedEntries = allEntries.slice(0, MAX_RECORDS);
  const readerDependencies = { ...previous.readerDependencies };
  const changedWork = boundedEntries.filter(entry => changedPaths.includes(entry.path) && sessionWorkPath(entry.path));
  if (changedWork.length) {
    const added = sessionWorkDependencies(projectRoot, changedWork, workContext, storage);
    const retained = previous.readerDependencies.sessionWork;
    const combine = field => [...new Map([...retained[field], ...added[field]].map(entry => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
    const repaired = new Set([...added.entries, ...added.layout].map(entry => entry.path));
    readerDependencies.sessionWork = { version: 1, entries: combine("entries"), layout: combine("layout"),
      unavailable: [...retained.unavailable.filter(entry => !repaired.has(entry.path)), ...added.unavailable], complete: retained.complete && added.complete };
  }
  const recordsDigest = projectGraphDigest({ projectId: project.projectId, projectRoot, entries: boundedEntries, unavailable, complete,
    readerDependencies });
  const retainedRows = navigationRows({ ...previous, entries: boundedEntries }).values();
  const addedNavigation = buildSessionWorkNavigation(projectRoot, changedWork, workContext, changedBytes, storage);
  const sessionWorkNavigation = { version: 1, rows: [...retainedRows].filter(row => !changedPaths.includes(row.path))
    .concat(addedNavigation.rows).sort((a, b) => a.path.localeCompare(b.path)) };
  const sessionTodoNavigation = { version: 1, rows: [...todoNavigationRows({ ...previous, entries: boundedEntries }).values()]
    .filter(row => !changedPaths.includes(row.path)).concat(addedNavigation.todoRows).sort((a, b) => a.path.localeCompare(b.path)) };
  return publishInventory(projectRoot, { ...previous, authorityBoundary: artifactAuthorityBoundary("ProjectGraphRecordIndex"),
    entries: boundedEntries, unavailable, complete, recordsDigest, readerDependencies, sessionWorkNavigation, sessionTodoNavigation }, storage);
}

// Writers already verified/persisted their evidence. Index failure is a loss
// of a derived optimization and cannot undo that success or demand reapproval.
export function noteProjectGraphChange(root, changedPaths = null) {
  try { return changedPaths ? updateProjectGraphIndex(root, changedPaths) : refreshProjectGraphIndex({ root }); }
  catch (error) { return { status: "unavailable", reasonCode: error.code || "PROJECT_GRAPH_INDEX_UNAVAILABLE", ordinaryWorkBlocked: false }; }
}
