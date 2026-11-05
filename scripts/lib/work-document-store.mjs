import fs from "node:fs";
import path from "node:path";
import { readSessionWorkContext, readSessionWorkEvidenceOwner } from "./session-work-context.mjs";
import { safeSessionPath } from "./session-paths.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { workDocumentHash } from "./work-document-source.mjs";

export const documentFailure = (message, code = "WORK_DOCUMENT_UNVERIFIED") => { throw Object.assign(new Error(message), { code }); };
function documentOwner({ root, sessionId }) {
  sessionId ??= readSessionWorkContext({ root, evidenceIds: [], maxRecords: 1, maxCharacters: 2 }).sessionId;
  return readSessionWorkEvidenceOwner({ root, sessionId });
}

function operationalStore(owner, area) {
  const file = (...parts) => safeSessionPath(owner.root, formatForVerifiedOwner(owner.storage).directory, "document-projection", ...area, ...parts);
  const read = (...parts) => {
    const target = file(...parts);
    let bytes;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) documentFailure("Invalid document record.", "WORK_DOCUMENT_RECORD_TAMPER");
      bytes = fs.readFileSync(target);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let record;
    try {record=JSON.parse(bytes.toString("utf8"));} catch {documentFailure("Invalid document record JSON.","WORK_DOCUMENT_RECORD_TAMPER");}
    if(!record||typeof record!=="object"||Array.isArray(record))documentFailure("Invalid document record shape.","WORK_DOCUMENT_RECORD_TAMPER");
    const { digest, ...payload } = record;
    if (digest !== workDocumentHash(payload) || payload.projectId !== owner.projectId || payload.sessionId !== owner.sessionId
      || payload.authorityPlane !== "P5" || payload.executionReplayAllowed !== false) documentFailure("Document record integrity differs.", "WORK_DOCUMENT_RECORD_TAMPER");
    return record.value;
  };
  const write = (parts, value, replace = false) => {
    const target = file(...parts), payload = { schemaVersion: 1, kind: "WorkDocumentOperationalRecord", authorityPlane: "P5",
      projectId: owner.projectId, sessionId: owner.sessionId, executionReplayAllowed: false, value };
    const body = JSON.stringify({ ...payload, digest: workDocumentHash(payload) }, null, 2) + "\n";
    if (fs.existsSync(target)) {
      if (workDocumentHash(read(...parts)) === workDocumentHash(value)) return value;
      if (!replace) documentFailure("Divergent document retry.", "WORK_DOCUMENT_REPLAY_CONFLICT");
    }
    fs.mkdirSync(safeSessionPath(owner.root, path.relative(owner.root, path.dirname(target))), { recursive: true });
    // Both writers stage beside the target; creates never overwrite an original.
    (replace ? atomicWriteArtifact : atomicCreateArtifact)(file(...parts), body);
    return value;
  };
  return { owner, file, read, write };
}

export function workDocumentStore(options) {
  const owner = documentOwner(options);
  return operationalStore(owner, ["work", owner.sessionId]);
}

// Shared delivery state, not shared Session direction. The selected caller is
// verified through the same owner reader, while persisted records are explicitly
// Project-scoped and cannot acquire another Session's P2 fields.
export function projectDocumentStore(options) {
  const caller = documentOwner(options);
  return { ...operationalStore({ ...caller, sessionId: null }, ["project", caller.projectId]), caller };
}

// Derived preparation is stored in bounded carriers, rather than one oversized
// operational record. Page/list preparation can use several values; this is not
// a feature/document-count limit or a claim that a prefix is the whole Project.
export function storeDocumentValue(store, value) {
  const bytes = Buffer.from(JSON.stringify(value)), digest = workDocumentHash(bytes), chunks = [];
  if (bytes.length > 64 * 1024 * 1024) documentFailure("Split large derived preparation into page/list values.", "PROJECT_DOCUMENT_VALUE_BOUND");
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const part = bytes.subarray(offset, offset + 256 * 1024), id = workDocumentHash(part);
    store.write(["value-chunks", `${id}.json`], { bytes: part.length, base64: part.toString("base64") }); chunks.push(id);
  }
  store.write(["values", `${digest}.json`], { digest, bytes: bytes.length, chunks });
  return digest;
}

export function readDocumentValue(store, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || "")) documentFailure("Invalid prepared value identity.", "WORK_DOCUMENT_RECORD_TAMPER");
  const index = store.read("values", `${digest}.json`);
  if (!index || index.digest !== digest || !Number.isSafeInteger(index.bytes) || index.bytes < 1 || index.bytes > 64 * 1024 * 1024
    || !Array.isArray(index.chunks) || index.chunks.length !== Math.ceil(index.bytes / (256 * 1024))) documentFailure("Prepared value index differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  const chunks = index.chunks.map(id => {
    if (!/^[a-f0-9]{64}$/.test(id || "")) documentFailure("Invalid chunk identity.", "WORK_DOCUMENT_RECORD_TAMPER");
    const chunk = store.read("value-chunks", `${id}.json`);
    if (!chunk || typeof chunk.base64 !== "string" || chunk.base64.length > 350000) documentFailure("Prepared chunk is unavailable.", "WORK_DOCUMENT_RECORD_TAMPER");
    const bytes = Buffer.from(chunk.base64, "base64");
    if (bytes.length !== chunk.bytes || bytes.length > 256 * 1024 || bytes.toString("base64") !== chunk.base64 || workDocumentHash(bytes) !== id) documentFailure("Prepared chunk digest differs.", "WORK_DOCUMENT_RECORD_TAMPER");
    return bytes;
  });
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== index.bytes || workDocumentHash(bytes) !== digest) documentFailure("Prepared value digest differs.", "WORK_DOCUMENT_RECORD_TAMPER");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { documentFailure("Prepared value encoding differs.", "WORK_DOCUMENT_RECORD_TAMPER"); }
}
