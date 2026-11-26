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
// The staging name the no-clobber create uses (fs-atomic staged()). An
// interrupted create can leave it alone, or hard-linked to the published record.
const STAGING_NAME = /^\.(retention-release-[a-f0-9]{24}\.json)\.[0-9a-f-]{36}\.tmp$/;
// The reader refuses a record larger than this; the writer splits an apply's
// releases so no record comes near it (an entry is well under 1 KiB).
export const RETENTION_RELEASE_MAX_BYTES = 4 * 1024 * 1024;
export const RETENTION_RELEASE_MAX_ENTRIES = 2000;
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

// The records one apply writes: its releases split so that no record exceeds
// RETENTION_RELEASE_MAX_ENTRIES entries (and so stays far below the reader's bound).
export function planRetentionReleases({ released, maxEntries = RETENTION_RELEASE_MAX_ENTRIES, ...rest }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) failure("RETENTION_RELEASE_INVALID");
  const documents = [];
  for (let start = 0; start < released.length; start += maxEntries)
    documents.push(buildRetentionRelease({ ...rest, released: released.slice(start, start + maxEntries) }));
  return documents;
}

// Writes a new record without replacing any file. Returns its store-relative path.
export function writeRetentionRelease({ root, storage, document }) {
  const directory = path.join(root, storage.directory, RETENTION_RELEASE_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, document.releaseId + ".json");
  const text = JSON.stringify(document, null, 2) + "\n";
  if (Buffer.byteLength(text) > RETENTION_RELEASE_MAX_BYTES) failure("RETENTION_RELEASE_TOO_LARGE");
  atomicCreateArtifact(file, text);
  return storage.directory + "/" + RETENTION_RELEASE_DIRECTORY + "/" + document.releaseId + ".json";
}

// Every verified record in the store. `released` maps each released id (whole
// snapshot ids and their identity ids) to the latest record that names it;
// `problems` names each record that could not be used. A problem record
// excuses nothing.
export function readRetentionReleases({ root, storage, projectId }) {
  const released = new Map(),
    problems = [],
    records = [],
    staging = [];
  const directory = path.join(root, storage.directory, RETENTION_RELEASE_DIRECTORY);
  let names = [];
  try {
    names = fs.readdirSync(directory).sort();
  } catch (error) {
    if (error.code !== "ENOENT")
      problems.push({ path: storage.directory + "/" + RETENTION_RELEASE_DIRECTORY, reasonCode: error.code || "RETENTION_RELEASE_UNREADABLE" });
    return { released, problems, records, staging };
  }
  // A staging file an interrupted create left: alone (the record was never
  // published, and since a record is written before any unlink, nothing it would
  // have listed was deleted), or hard-linked to the record it published. Either
  // way it is the create's own leftover: named, never read, never an issue.
  const stagingInodes = new Map();
  for (const name of names) {
    const match = STAGING_NAME.exec(name);
    if (!match) continue;
    const relative = storage.directory + "/" + RETENTION_RELEASE_DIRECTORY + "/" + name;
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) failure("RETENTION_RELEASE_UNSAFE");
      stagingInodes.set(match[1], { dev: stat.dev, ino: stat.ino });
      staging.push({ path: relative, record: match[1], note: "left by an interrupted create; ignored" });
    } catch (error) {
      problems.push({ path: relative, reasonCode: error.code || "RETENTION_RELEASE_UNREADABLE" });
    }
  }
  for (const name of names) {
    if (STAGING_NAME.test(name)) continue;
    const relative = storage.directory + "/" + RETENTION_RELEASE_DIRECTORY + "/" + name;
    try {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      // Two links are allowed only when the other one is this record's own staging file.
      const pair = stagingInodes.get(name);
      const links = stat.nlink === 1 || (stat.nlink === 2 && pair && pair.dev === stat.dev && pair.ino === stat.ino);
      if (!stat.isFile() || stat.isSymbolicLink() || !links || stat.size > RETENTION_RELEASE_MAX_BYTES) failure("RETENTION_RELEASE_UNSAFE");
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
            released.set(id, {
              releaseId: document.releaseId,
              releasedAt: document.releasedAt,
              snapshotId: entry.id,
              // The released snapshot's own hash, for its own id only.
              hash: id === entry.id ? entry.hash : null,
              path: relative,
            });
        }
    } catch (error) {
      problems.push({
        path: relative,
        reasonCode: error.code || (error instanceof SyntaxError ? "RETENTION_RELEASE_INVALID" : "RETENTION_RELEASE_UNREADABLE"),
      });
    }
  }
  return { released, problems, records, staging };
}

// The answer a reader gives for a snapshot id that is not stored: released by
// retention (with the date and the record) or null when no record names it.
// A World the current World pointer names (as current or as its previous) is
// never "released": if it is missing, it is missing.
export function retentionReleaseOf({ root, storage, projectId, id }) {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, storage.directory, "world-model", "current.json"), "utf8"));
    if (pointer && (pointer.worldModelId === id || pointer.previousWorldModelId === id)) return null;
  } catch {
    // No readable pointer: nothing is current, so nothing is excluded here.
  }
  const { released } = readRetentionReleases({ root, storage, projectId });
  return released.get(id) || null;
}

// The one rule for a reference to a snapshot that is not stored, used by the
// apply and by the dry run alike:
//   - no valid release record names the id: "missing" (an issue);
//   - the reference names a World by hash and the record's hash differs: "missing";
//   - history names it (an older refresh record, or a stored snapshot's own
//     lineage ids): "released-history";
//   - any other root names it (a Capsule, a checkpoint, Session work, a
//     knowledge decision, ... written before or after the release): "released-in-record".
//     A pin can keep a snapshot from being released, but it cannot bring one
//     back: such a reference is reported on every run and never blocks GC.
//   - anything else (a stored snapshot's own content): "missing".
//   - a current pointer, or a record a current pointer names: "missing" for
//     what it names as current (a World id comes back when its content does,
//     so a released id can be current again, and the current World being gone
//     is damage whatever an old record says); only the lineage ids it lists
//     (a parent list) are history.
// Byte pins are judged elsewhere and never excused.
export function judgeMissingReference({ release, digest = null, fromRoot, history, current = false, lineage = false }) {
  if (!release) return "missing";
  if (current) return lineage && (digest === null || release.hash === digest) ? "released-history" : "missing";
  if (digest !== null && release.hash !== digest) return "missing";
  if (history) return "released-history";
  if (fromRoot) return "released-in-record";
  return "missing";
}

export const releasedMessage = (id, release) => `${id} was released by retention on ${release.releasedAt} (${release.releaseId}).`;
