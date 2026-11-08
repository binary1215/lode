import fs from "node:fs";
import path from "node:path";
import { validatePortableManifestFormat } from "./portable-project-format.mjs";
import crypto from "node:crypto";
import { copiedProjectFile, verifyCopiedProjectFile } from "./project-copy-evidence.mjs";
import { readSnapshotFile, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { verifyProjectLocationOriginals } from "./project-location-proof.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fail = () => {
  throw Object.assign(new Error("Imported default Session ownership proof is invalid."), {
    code: "HEAD_SESSION_IMPORT_OWNER_INVALID",
  });
};
const read = (root, relative) =>
  readSnapshotFile(copiedProjectFile(root, relative), {
    decodedBytes: SNAPSHOT_STORAGE_LIMITS.decodedBytes,
  });

// Evidence for exactly the original default-format bytes, not an exemption for
// new named records or modified files lacking their required Project identity.
export function verifyImportedDefaultSession({
  root,
  directory,
  project,
  sessionId,
  stateFile,
  stateBytes,
  onOriginal = null,
  readOriginal = null,
  verifyOriginal = null,
}) {
  const sourceRead = (relative) => {
    const result = readOriginal ? readOriginal(relative) : read(root, relative);
    if (!result) fail();
    onOriginal?.(relative, result.bytes, result.document);
    return result;
  };
  const relative = path.relative(root, stateFile).replaceAll("\\", "/");
  const sessionDirectory = directory + "/sessions/by-id/" + sessionId;
  if (relative !== sessionDirectory + "/current.json") return false;
  const originalSha256 = hash(stateBytes);
  const ownerPath = sessionDirectory + "/imports/owners/" + originalSha256 + ".json";
  const ownerFile = copiedProjectFile(root, ownerPath);
  if (readOriginal ? !readOriginal(ownerPath) : !fs.lstatSync(ownerFile, { throwIfNoEntry: false })) return false;
  const owner = sourceRead(ownerPath).document;
  if (
    owner.schemaVersion !== 1 ||
    owner.kind !== "ImportedDefaultSessionOwnerProof" ||
    owner.authorityPlane !== "P3" ||
    owner.projectId !== project.projectId ||
    owner.sessionId !== sessionId ||
    owner.originalSha256 !== originalSha256 ||
    owner.targetPath !== relative ||
    owner.sourcePath !== directory + "/sessions/current.json" ||
    typeof owner.bundleId !== "string" ||
    !/^project-bundle-[a-f0-9]{24}$/.test(owner.bundleId) ||
    owner.grantsRecoveryDirection !== false ||
    owner.grantsExecutionAuthorization !== false
  )
    fail();
  const archive = sessionDirectory + "/imports/" + owner.bundleId;
  const receipt = sourceRead(archive + "/receipt.json").document;
  const { receiptId, receiptDigest, ...payload } = receipt;
  if (
    receipt.kind !== "SelectedSessionImportReceipt" ||
    receipt.projectId !== project.projectId ||
    receipt.sessionId !== sessionId ||
    receipt.bundleId !== owner.bundleId ||
    receiptDigest !== owner.receiptDigest ||
    receiptDigest !== hash(json(payload)) ||
    receiptId !== "session-import-" + receiptDigest.slice(0, 24) ||
    receipt.sourceDefaultFormat !== true ||
    receipt.stateOriginal.sourcePath !== owner.sourcePath ||
    receipt.stateOriginal.path !== relative ||
    receipt.stateOriginal.sha256 !== originalSha256
  )
    fail();
  const bundle = sourceRead(archive + "/bundle-manifest.json");
  if (
    hash(bundle.bytes) !== receipt.manifestSha256 ||
    owner.bundleId !== "project-bundle-" + receipt.manifestSha256.slice(0, 24) ||
    bundle.document.projectId !== project.projectId ||
    bundle.document.selectedSessionId !== sessionId ||
    bundle.document.selectedSessionPath !== owner.sourcePath
  )
    fail();
  validatePortableManifestFormat(bundle.document);
  const sourceBytes = (relative) => {
    const declared = bundle.document.files.find((entry) => entry.path === relative);
    const mapping = receipt.historicalOriginals.find((entry) => entry.sourcePath === relative && entry.sha256 === declared?.sha256);
    if (!declared || !mapping || mapping.storedPath !== archive + "/originals/" + declared.sha256 + ".bin") fail();
    if (!readOriginal)
      verifyCopiedProjectFile(root, {
        path: mapping.storedPath,
        bytes: declared.bytes,
        sha256: declared.sha256,
      });
    const bytes = sourceRead(mapping.storedPath).bytes;
    if (bytes.length !== declared.bytes || hash(bytes) !== declared.sha256) fail();
    return bytes;
  };
  const sourceProject = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes(directory + "/project.json")));
  if (sourceProject.projectId !== project.projectId || hash(sourceBytes(directory + "/project.json")) !== bundle.document.sourceProjectDigest) fail();
  verifyProjectLocationOriginals({ directory, project: sourceProject, readOriginal: sourceBytes });
  const originalState = sourceBytes(owner.sourcePath);
  if (hash(originalState) !== originalSha256 || !originalState.equals(stateBytes)) fail();
  const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(originalState));
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || (state.projectId != null && state.projectId !== project.projectId)) fail();
  if (verifyOriginal && verifyOriginal({ sourceBytes, state, receipt }) !== true) fail();
  return true;
}
