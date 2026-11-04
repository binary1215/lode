import fs from "node:fs";
import path from "node:path";
import { readSessionWorkContext, readSessionWorkEvidenceOwner } from "./session-work-context.mjs";
import { safeSessionPath } from "./session-paths.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { workDocumentHash } from "./work-document-source.mjs";

export const documentFailure = (message, code = "WORK_DOCUMENT_UNVERIFIED") => { throw Object.assign(new Error(message), { code }); };
export function workDocumentStore({ root, sessionId }) {
  sessionId ??= readSessionWorkContext({ root, evidenceIds: [], maxRecords: 1, maxCharacters: 2 }).sessionId;
  const owner = readSessionWorkEvidenceOwner({ root, sessionId });
  const file = (...parts) => safeSessionPath(owner.root, formatForVerifiedOwner(owner.storage).directory, "document-projection", "work", owner.sessionId, ...parts);
  const read = (...parts) => {
    const target = file(...parts);
    let bytes;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) documentFailure("Invalid document record.", "WORK_DOCUMENT_RECORD_TAMPER");
      bytes = fs.readFileSync(target);
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const record = JSON.parse(bytes.toString("utf8")), { digest, ...payload } = record;
    if (digest !== workDocumentHash(payload) || payload.projectId !== owner.projectId || payload.sessionId !== owner.sessionId
      || payload.authorityPlane !== "P5" || payload.executionReplayAllowed !== false) documentFailure("Document record integrity differs.", "WORK_DOCUMENT_RECORD_TAMPER");
    return record.value;
  };
  const write = (parts, value, replace = false) => {
    const target = file(...parts), payload = { schemaVersion: 1, kind: "WorkDocumentOperationalRecord", authorityPlane: "P5",
      projectId: owner.projectId, sessionId: owner.sessionId, executionReplayAllowed: false, value };
    const body = JSON.stringify({ ...payload, digest: workDocumentHash(payload) }, null, 2) + "\n";
    if (!replace && fs.existsSync(target)) {
      if (workDocumentHash(read(...parts)) !== workDocumentHash(value)) documentFailure("Divergent document retry.", "WORK_DOCUMENT_REPLAY_CONFLICT");
      return value;
    }
    fs.mkdirSync(safeSessionPath(owner.root, path.relative(owner.root, path.dirname(target))), { recursive: true });
    // Both writers stage beside the target; creates never overwrite an original.
    (replace ? atomicWriteArtifact : atomicCreateArtifact)(file(...parts), body);
    return value;
  };
  return { owner, file, read, write };
}
