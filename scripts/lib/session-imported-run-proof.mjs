import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { readSnapshotFile, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { verifyImportedDefaultSession } from "./session-import-proof.mjs";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw Object.assign(new Error("Imported Run ownership proof is invalid."), {
    code: "RUN_IMPORT_OWNER_INVALID",
  });
};
// An exact old default-owned Run remains historical evidence. This proof never
// assigns ownership to new/changed ownerless Runs or creates execution rights.
export function verifyImportedDefaultRun({ root, directory, project, sessionId, runFile, runBytes, run, onOriginal = null, readOriginal = null }) {
  if (!run || run.sessionId != null || typeof run.runId !== "string" || !/^run-[0-9]+-[a-f0-9]{6}$/.test(run.runId)) return false;
  if (JSON.stringify(JSON.parse(runBytes)) !== JSON.stringify(run)) fail();
  const relative = path.relative(root, runFile).replaceAll("\\", "/");
  if (relative !== directory + "/sessions/runs/" + run.runId + "/run.json") return false;
  const sessionDirectory = directory + "/sessions/by-id/" + sessionId;
  const sourceRead = (relative) => {
    const result = readOriginal
      ? readOriginal(relative)
      : readSnapshotFile(copiedProjectFile(root, relative), {
          decodedBytes: SNAPSHOT_STORAGE_LIMITS.decodedBytes,
        });
    if (result) onOriginal?.(relative, result.bytes, result.document);
    return result;
  };
  const digest = sha(runBytes),
    indexPath = sessionDirectory + "/imports/run-owners/" + digest + ".json";
  if (!readOriginal && !fs.lstatSync(copiedProjectFile(root, indexPath), { throwIfNoEntry: false })) return false;
  const index = sourceRead(indexPath)?.document;
  if (!index) return false;
  if (
    index.schemaVersion !== 1 ||
    index.kind !== "ImportedDefaultRunOwnerProof" ||
    index.authorityPlane !== "P3" ||
    index.projectId !== project.projectId ||
    index.sessionId !== sessionId ||
    index.runId !== run.runId ||
    index.path !== relative ||
    index.originalSha256 !== digest ||
    typeof index.sourceStateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(index.sourceStateSha256) ||
    index.grantsRecoveryDirection !== false ||
    index.grantsExecutionAuthorization !== false
  )
    fail();
  const owner = sourceRead(sessionDirectory + "/imports/owners/" + index.sourceStateSha256 + ".json")?.document;
  if (!owner || typeof owner.bundleId !== "string" || !/^project-bundle-[a-f0-9]{24}$/.test(owner.bundleId)) fail();
  const sourceState = sourceRead(sessionDirectory + "/imports/" + owner.bundleId + "/originals/" + index.sourceStateSha256 + ".bin");
  if (!sourceState || sha(sourceState.bytes) !== index.sourceStateSha256) fail();
  return verifyImportedDefaultSession({
    root,
    directory,
    project,
    sessionId,
    stateFile: path.join(root, sessionDirectory, "current.json"),
    stateBytes: sourceState.bytes,
    onOriginal,
    readOriginal,
    verifyOriginal({ sourceBytes, state }) {
      if (![state.activeRunId, state.pendingReview?.runId, state.lastReviewedRunId].includes(run.runId)) return false;
      return sourceBytes(relative).equals(runBytes);
    },
  });
}
