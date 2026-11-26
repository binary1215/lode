import fs from "node:fs";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { readSnapshotFile, SNAPSHOT_STORAGE_LIMITS } from "../world/snapshot-storage-codec.mjs";
import { sha256Hex as sha } from "../core/digest.mjs";
const groups = new WeakMap();
const bytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
export const codexRegistrationMetadataDigest = (value) => (value === null ? null : sha(JSON.stringify(value)));
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
function read(root, relative) {
  const file = copiedProjectFile(root, relative),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("NATIVE_CODEX_REGISTRATION_GROUP_INVALID");
  return readSnapshotFile(file);
}
const flags = {
  automaticReplayAllowed: false,
  grantsRecoveryAuthority: false,
  restoresExecutionPermission: false,
};
function metadataRows(selection, metadata) {
  return selection.map(({ threadId }) => ({
    threadId,
    digest: codexRegistrationMetadataDigest(metadata.get(threadId) ?? null),
  }));
}
function validateRows(selection, rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== selection.length ||
    rows.some(
      (row, i) =>
        !row || Object.keys(row).length !== 2 || row.threadId !== selection[i].threadId || (row.digest !== null && !/^[a-f0-9]{64}$/.test(row.digest)),
    )
  )
    fail("NATIVE_CODEX_REGISTRATION_GROUP_INVALID");
}
export function codexRegistrationInitialMetadataDigest(group, threadId) {
  const row = state(group).document.initialMetadata.find((row) => row.threadId === threadId);
  if (!row) fail("NATIVE_CODEX_REGISTRATION_GROUP_INVALID");
  return row.digest;
}
function state(group) {
  const value = groups.get(group);
  if (!value) fail("NATIVE_CODEX_REGISTRATION_GROUP_REQUIRED");
  return value;
}
export function prepareCodexRegistrationGroup({ operationRoot, identity, selection, metadata }) {
  const groupId = "codex-registration-group-" + sha(bytes({ identity, selection })).slice(0, 24),
    relative = groupId + ".json";
  let rows = metadataRows(selection, metadata),
    published = false;
  const file = copiedProjectFile(operationRoot, relative);
  if (fs.existsSync(file)) {
    rows = read(operationRoot, relative).document.initialMetadata;
    published = true;
  }
  validateRows(selection, rows);
  const document = {
    schemaVersion: 1,
    kind: "CodexNativeRegistrationGroup",
    authorityPlane: "P5",
    identity,
    selection,
    initialMetadata: rows,
    ...flags,
  };
  const encoded = bytes(document),
    groupDigest = sha(encoded);
  if (published && !read(operationRoot, relative).bytes.equals(encoded)) fail("NATIVE_CODEX_REGISTRATION_GROUP_INVALID");
  const group = Object.freeze({
    groupId,
    groupDigest,
  });
  // Keep exact originals behind a branded capability, not caller-supplied JSON.
  // This Host evidence supplies neither an authorization nor a native owner.
  groups.set(group, { operationRoot, relative, document, encoded, groupDigest, published });
  return group;
}
export function assertCodexRegistrationGroupCurrent(group) {
  const value = state(group),
    file = copiedProjectFile(value.operationRoot, value.relative);
  if (!fs.existsSync(file)) {
    if (value.published) fail("NATIVE_CODEX_REGISTRATION_GROUP_CHANGED");
    return;
  }
  if (!read(value.operationRoot, value.relative).bytes.equals(value.encoded)) fail("NATIVE_CODEX_REGISTRATION_GROUP_CHANGED");
}
export function persistCodexRegistrationGroup(group) {
  const value = state(group);
  assertCodexRegistrationGroupCurrent(group);
  try {
    atomicCreateArtifact(copiedProjectFile(value.operationRoot, value.relative), value.encoded);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  value.published = true;
  assertCodexRegistrationGroupCurrent(group);
}
export function assertCodexRegistrationMetadata(group, metadata, expected = null) {
  const value = state(group),
    actual = metadataRows(value.document.selection, metadata),
    wanted = expected ?? value.document.initialMetadata;
  validateRows(value.document.selection, wanted);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail("NATIVE_CODEX_REGISTRATION_TARGET_APPEARED");
}
function evidence(groupDigest, progressDigest, apiEvidenceDigest) {
  return sha(
    bytes({
      kind: "CodexNativeRegistrationMemberEvidence",
      groupDigest,
      progressDigest,
      apiEvidenceDigest,
    }),
  );
}
function progressDocument(group, { index, operationId, inputDigest, previousProgressDigest, selectedMetadata, apiEvidenceDigest }) {
  const value = state(group);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= value.document.selection.length ||
    !/^native-registration-[a-f0-9]{24}$/.test(operationId) ||
    !/^[a-f0-9]{64}$/.test(inputDigest) ||
    !/^[a-f0-9]{64}$/.test(apiEvidenceDigest) ||
    (previousProgressDigest !== null && !/^[a-f0-9]{64}$/.test(previousProgressDigest))
  )
    fail("NATIVE_CODEX_REGISTRATION_GROUP_INVALID");
  validateRows(value.document.selection, selectedMetadata);
  return {
    schemaVersion: 1,
    kind: "CodexNativeRegistrationMemberSnapshot",
    authorityPlane: "P5",
    groupDigest: value.groupDigest,
    index,
    threadId: value.document.selection[index].threadId,
    operationId,
    inputDigest,
    previousProgressDigest,
    selectedMetadata,
    apiEvidenceDigest,
    ...flags,
  };
}
export function recordCodexRegistrationMember(group, { metadata, ...options }) {
  assertCodexRegistrationGroupCurrent(group);
  const value = state(group);
  if (!value.published) fail("NATIVE_CODEX_REGISTRATION_GROUP_REQUIRED");
  const document = progressDocument(group, {
      ...options,
      selectedMetadata: metadataRows(value.document.selection, metadata),
    }),
    encoded = bytes(document),
    relative = value.relative + ".member-" + options.index + ".json";
  try {
    atomicCreateArtifact(copiedProjectFile(value.operationRoot, relative), encoded);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!read(value.operationRoot, relative).bytes.equals(encoded)) fail("NATIVE_CODEX_REGISTRATION_GROUP_CHANGED");
  }
  const progressDigest = sha(encoded);
  return {
    progressDigest,
    evidenceDigest: evidence(value.groupDigest, progressDigest, document.apiEvidenceDigest),
    selectedMetadata: document.selectedMetadata,
  };
}
// A snapshot alone is not completion. Only the exact actual member result may
// anchor it; missing/uncertain results never authorize another SDK delivery.
export function readCodexRegistrationMember(group, { index, operationId, inputDigest, previousProgressDigest, evidenceDigest }) {
  assertCodexRegistrationGroupCurrent(group);
  const value = state(group),
    original = read(value.operationRoot, value.relative + ".member-" + index + ".json"),
    document = original.document;
  const expected = progressDocument(group, {
    index,
    operationId,
    inputDigest,
    previousProgressDigest,
    selectedMetadata: document.selectedMetadata,
    apiEvidenceDigest: document.apiEvidenceDigest,
  });
  if (!original.bytes.equals(bytes(expected))) fail("NATIVE_CODEX_REGISTRATION_GROUP_CHANGED");
  const progressDigest = sha(original.bytes);
  if (evidence(value.groupDigest, progressDigest, expected.apiEvidenceDigest) !== evidenceDigest) fail("NATIVE_CODEX_REGISTRATION_GROUP_RESULT_MISMATCH");
  return { progressDigest, evidenceDigest, selectedMetadata: expected.selectedMetadata };
}
