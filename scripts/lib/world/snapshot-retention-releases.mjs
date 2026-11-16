import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../core/canonical-json.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { failCode as failure } from "../core/errors.mjs";

// A retention release record says which World and Graph snapshots a windowed
// storage GC apply released, and when. The apply writes one before it unlinks
// anything; it is append-only, never rewritten and never reclaimed. Refresh
// history that still names a released id then reads as "released by retention
// on <date>" instead of missing, in every later GC mode and in the readers.
// A record that cannot be read or verified excuses nothing.
export const RETENTION_RELEASE_DIRECTORY = "refresh/retention-releases";
const RELEASE_NAME = /^(retention-release-[a-f0-9]{24})\.json$/;
const WHOLE_ID = /^(?:world-model|graph-snapshot)-[a-f0-9]{24}$/;
const ANY_ID = /^(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_KEYS = ["collectionAttemptId", "kind", "policy", "projectId", "releaseHash", "releaseId", "releasedAt", "released", "schemaVersion"].sort();
const ENTRY_KEYS = ["hash", "id", "identityIds", "rule"].sort();

export const isRetentionReleasePath = (relative) => {
  const normalized = String(relative || "").replaceAll("\\", "/");
  const at = normalized.lastIndexOf(RETENTION_RELEASE_DIRECTORY + "/");
  return at >= 0 && (at === 0 || normalized[at - 1] === "/") && RELEASE_NAME.test(normalized.slice(at + RETENTION_RELEASE_DIRECTORY.length + 1));
};

function payloadOf(document) {
  const { releaseId, releaseHash, ...payload } = document;
  return payload;
}

export function buildRetentionRelease({ projectId, policy, collectionAttemptId, releasedAt = new Date().toISOString(), released }) {
  const payload = {
    schemaVersion: 1,
    kind: "SnapshotRetentionRelease",
    projectId,
    releasedAt,
    policy: { source: policy.source, keepCount: policy.keepCount, keepDays: policy.keepDays },
    collectionAttemptId,
    released: released
      .map((row) => ({ id: row.id, hash: row.hash, identityIds: [...new Set(row.identityIds)].sort(), rule: row.rule }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
  const releaseHash = sha256Hex(canonicalJson(payload));
  return verifyRetentionRelease({ ...payload, releaseId: "retention-release-" + releaseHash.slice(0, 24), releaseHash }, { projectId });
}

export function verifyRetentionRelease(document, { projectId = null, fileName = null } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) failure("RETENTION_RELEASE_INVALID");
  if (JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(RELEASE_KEYS)) failure("RETENTION_RELEASE_INVALID");
  if (document.schemaVersion !== 1 || document.kind !== "SnapshotRetentionRelease") failure("RETENTION_RELEASE_INVALID");
  if (typeof document.projectId !== "string" || (projectId && document.projectId !== projectId)) failure("RETENTION_RELEASE_PROJECT_MISMATCH");
  if (typeof document.releasedAt !== "string" || Number.isNaN(Date.parse(document.releasedAt))) failure("RETENTION_RELEASE_INVALID");
  if (typeof document.collectionAttemptId !== "string" || !document.collectionAttemptId) failure("RETENTION_RELEASE_INVALID");
  const policy = document.policy;
  if (
    !policy ||
    JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(["keepCount", "keepDays", "source"]) ||
    !["options", "project-file"].includes(policy.source) ||
    !Number.isSafeInteger(policy.keepCount) ||
    !Number.isSafeInteger(policy.keepDays)
  )
    failure("RETENTION_RELEASE_INVALID");
  if (!Array.isArray(document.released) || !document.released.length) failure("RETENTION_RELEASE_INVALID");
  for (const entry of document.released)
    if (
      !entry ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(ENTRY_KEYS) ||
      !WHOLE_ID.test(entry.id) ||
      !(entry.hash === null || HASH.test(entry.hash)) ||
      !Array.isArray(entry.identityIds) ||
      !entry.identityIds.includes(entry.id) ||
      !entry.identityIds.every((id) => ANY_ID.test(id)) ||
      !["outside-retention-window", "unreferenced"].includes(entry.rule)
    )
      failure("RETENTION_RELEASE_INVALID");
  const releaseHash = sha256Hex(canonicalJson(payloadOf(document)));
  if (document.releaseHash !== releaseHash || document.releaseId !== "retention-release-" + releaseHash.slice(0, 24))
    failure("RETENTION_RELEASE_DIGEST_MISMATCH");
  if (fileName !== null && fileName !== document.releaseId + ".json") failure("RETENTION_RELEASE_NAME_MISMATCH");
  return document;
}

// Writes a new record without replacing any file. Returns its store-relative path.
export function writeRetentionRelease({ root, storage, document }) {
  const directory = path.join(root, storage.directory, RETENTION_RELEASE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, document.releaseId + ".json");
  atomicCreateArtifact(file, JSON.stringify(document, null, 2) + "\n");
  return storage.directory + "/" + RETENTION_RELEASE_DIRECTORY + "/" + document.releaseId + ".json";
}

// Every verified record in the store. `released` maps each released id (whole
// snapshot ids and their identity ids) to the latest record that names it;
// `problems` names each record that could not be used. A problem record
// excuses nothing.
export function readRetentionReleases({ root, storage, projectId }) {
  const released = new Map(),
    problems = [],
    records = [];
  const directory = path.join(root, storage.directory, RETENTION_RELEASE_DIRECTORY);
  let names = [];
  try {
    names = fs.readdirSync(directory).sort();
  } catch (error) {
    if (error.code !== "ENOENT")
      problems.push({ path: storage.directory + "/" + RETENTION_RELEASE_DIRECTORY, reasonCode: error.code || "RETENTION_RELEASE_UNREADABLE" });
    return { released, problems, records };
  }
  for (const name of names) {
    const relative = storage.directory + "/" + RETENTION_RELEASE_DIRECTORY + "/" + name;
    try {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) failure("RETENTION_RELEASE_UNSAFE");
      if (!RELEASE_NAME.test(name)) failure("RETENTION_RELEASE_NAME_MISMATCH");
      const document = verifyRetentionRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file))), {
        projectId,
        fileName: name,
      });
      records.push({ path: relative, releaseId: document.releaseId, releasedAt: document.releasedAt, count: document.released.length });
      for (const entry of document.released)
        for (const id of entry.identityIds) {
          const known = released.get(id);
          if (!known || known.releasedAt < document.releasedAt)
            released.set(id, { releaseId: document.releaseId, releasedAt: document.releasedAt, snapshotId: entry.id, path: relative });
        }
    } catch (error) {
      problems.push({
        path: relative,
        reasonCode: error.code || (error instanceof SyntaxError ? "RETENTION_RELEASE_INVALID" : "RETENTION_RELEASE_UNREADABLE"),
      });
    }
  }
  return { released, problems, records };
}

// The answer a reader gives for a snapshot id that is not stored: released by
// retention (with the date and the record) or null when no record names it.
export function retentionReleaseOf({ root, storage, projectId, id }) {
  const { released } = readRetentionReleases({ root, storage, projectId });
  return released.get(id) || null;
}

export const releasedMessage = (id, release) => `${id} was released by retention on ${release.releasedAt} (${release.releaseId}).`;
