import fs from "node:fs";
import path from "node:path";
import { verifyProjectLocation, safeLocationFile, locationJournalRelative } from "./project-location-proof.mjs";
import { LEGACY_FORMAT, LEGACY_PROTOCOLS, PROTOCOL_PAIRS, KIND_PAIRS, VALUE_PAIRS } from "../../compat/head/format.mjs";
import { verifyCopiedGitOwner, verifyCopiedGitRef } from "./project-copy-git-proof.mjs";
import { verifyCopiedProjectFile } from "./project-copy-evidence.mjs";
import { sha256Hex as digest } from "./core/digest.mjs";
import { fail } from "./core/errors.mjs";

const lodeFormat = Object.freeze({
  dialect: "lode",
  directory: ".lode",
  projectPrefix: "lode-",
  roleField: "lode",
  sessionIdField: "lodeSessionId",
  protocol: (value) => (Object.hasOwn(PROTOCOL_PAIRS, value) ? PROTOCOL_PAIRS[value] : value),
  kind: (value) => (Object.hasOwn(KIND_PAIRS, value) ? KIND_PAIRS[value] : value),
  value: (value) => (Object.hasOwn(VALUE_PAIRS, value) ? VALUE_PAIRS[value] : value),
});
const markerBases = new WeakMap();
const copiedSnapshotReads = new WeakMap();
const copiedSnapshotEntries = new WeakMap();
const copiedGitReads = new WeakMap();

// Pure callers must carry the tuple from upper selection. A bare ID or a
// historical Project object never selects a new dialect, even with a lode ID.
export function formatForVerifiedOwner(owner) {
  const storage = owner?.storage ?? owner;
  if (!storage || typeof storage !== "object" || storage.dialect === undefined) return LEGACY_FORMAT;
  if (storage.dialect === "head" && storage.directory === ".head") return LEGACY_FORMAT;
  if (storage.dialect === "lode" && storage.directory === ".lode") return lodeFormat;
  fail("Project storage tuple is inconsistent.", "PROJECT_IDENTITY_MISMATCH");
}

export function relativeProjectArtifact(owner, ...neutralSegments) {
  return [formatForVerifiedOwner(owner).directory, ...neutralSegments].join("/");
}

// Select the original wire family without changing any original object. The
// owning verifier still checks its original version, strict shape and digest.
export function familyFormatForOriginal(family, record, expectedOwner) {
  if (family?.sessionIdentity === true && record && typeof record === "object") {
    const hasLegacy = Object.hasOwn(record, "headSessionId"),
      hasLode = Object.hasOwn(record, "lodeSessionId");
    if (hasLegacy && hasLode) return null;
    const format = hasLode ? lodeFormat : hasLegacy ? LEGACY_FORMAT : formatForVerifiedOwner(expectedOwner);
    return expectedOwner != null && formatForVerifiedOwner(expectedOwner).dialect !== format.dialect ? null : format;
  }
  if (family && typeof family === "object" && family.kind && record && typeof record === "object") {
    const hasLegacy = Object.hasOwn(record, "headSessionId"),
      hasLode = Object.hasOwn(record, "lodeSessionId");
    if (hasLegacy && hasLode) return null;
    const brandedKind = lodeFormat.kind(family.kind) !== LEGACY_FORMAT.kind(family.kind) && record.kind === lodeFormat.kind(family.kind);
    const format = hasLode || brandedKind ? lodeFormat : hasLegacy ? LEGACY_FORMAT : formatForVerifiedOwner(expectedOwner);
    if (record.kind !== format.kind(family.kind)) return null;
    if (expectedOwner != null && formatForVerifiedOwner(expectedOwner).dialect !== format.dialect) return null;
    return format;
  }
  // A family is named by either spelling of a registered protocol.
  const named = typeof family === "string";
  const legacy = named ? (Object.hasOwn(LEGACY_PROTOCOLS, family) ? LEGACY_PROTOCOLS[family] : family) : family?.legacy;
  const canonical = named
    ? Object.hasOwn(PROTOCOL_PAIRS, family)
      ? PROTOCOL_PAIRS[family]
      : Object.hasOwn(LEGACY_PROTOCOLS, family)
        ? family
        : null
    : family?.lode;
  if (!legacy || !canonical || !record || typeof record !== "object") return null;
  const originalProtocol = typeof record.protocol === "string" ? record.protocol : record.protocol?.name;
  const format = originalProtocol === legacy ? LEGACY_FORMAT : originalProtocol === canonical ? lodeFormat : null;
  if (!format) return null;
  const opposite = format.dialect === "head" ? "lodeSessionId" : "headSessionId";
  if (Object.hasOwn(record, opposite)) return null;
  if (expectedOwner != null && formatForVerifiedOwner(expectedOwner).dialect !== format.dialect) return null;
  return format;
}

function marker(root, directory) {
  const projectFile = path.join(root, directory, "project.json");
  let bytes;
  try {
    bytes = fs.readFileSync(projectFile);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent", projectFile };
    return { state: "unknown", projectFile, error };
  }
  let project;
  try {
    project = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { state: "unknown", projectFile, error: Object.assign(new Error(`Project canon is invalid JSON: ${error.message}`), { code: "INVALID_CANON" }) };
  }
  if (directory === ".head") {
    if (project?.schemaVersion !== 1 || project.projectRoot !== root) return { state: "foreign", projectFile, project, bytes };
    if (fs.existsSync(safeLocationFile(root, directory, locationJournalRelative)))
      fail("Resume the exact pending Project folder relocation.", "PROJECT_RELOCATION_PENDING");
    return { state: "owned", projectFile, project, bytes, location: project.location ? verifyProjectLocation(root, directory, project) : null };
  }
  const expectedId = `lode-${digest(root).slice(0, 20)}`;
  const branded =
    project?.schemaVersion === 1 &&
    typeof project.projectId === "string" &&
    typeof project.projectRoot === "string" &&
    typeof project.authority?.lode === "string" &&
    typeof project.authority?.user === "string";
  const related = project?.projectRoot === root || project?.projectId === expectedId;
  if (!branded || !related) return { state: "foreign", projectFile, project, bytes };
  if (fs.existsSync(safeLocationFile(root, directory, locationJournalRelative)))
    fail("Resume the exact pending Project folder relocation.", "PROJECT_RELOCATION_PENDING");
  if (
    typeof project.createdAt !== "string" ||
    !Number.isFinite(Date.parse(project.createdAt)) ||
    !Array.isArray(project.runtimes) ||
    !project.runtimes.length ||
    !project.runtimes.every((value) => typeof value === "string") ||
    !project.integrations ||
    typeof project.integrations !== "object" ||
    Array.isArray(project.integrations)
  ) {
    fail("Recognized Lode Project canon is malformed.", "INVALID_CANON");
  }
  if (project.projectRoot !== root || (!project.location && project.projectId !== expectedId) || Object.hasOwn(project.authority, "head")) {
    fail("Project canon does not match this canonical root.", "PROJECT_IDENTITY_MISMATCH");
  }
  for (const candidate of [path.join(root, directory), projectFile]) {
    if (fs.lstatSync(candidate).isSymbolicLink()) fail(`Managed path traverses a symlink: ${candidate}`, "SYMLINK_PATH");
  }
  return { state: "owned", projectFile, project, bytes, location: project.location ? verifyProjectLocation(root, directory, project) : null };
}

// This is the existing upper Project-selection boundary only. It deliberately
// does not read a Session, manifest, World, graph or operational lease.
export function resolveProjectStorage(root = ".", { readLegacyProject } = {}) {
  const projectRoot = fs.realpathSync(path.resolve(root || "."));
  const legacy = marker(projectRoot, ".head");
  const canonical = marker(projectRoot, ".lode");
  if (legacy.state === "owned" && canonical.state === "owned") {
    fail("Two owned Project storage roots conflict.", "PROJECT_STORAGE_CONFLICT");
  }
  const selected = legacy.state === "owned" ? legacy : canonical.state === "owned" ? canonical : null;
  if (!selected) {
    // Preserve the original legacy marker dependency and its diagnostic cause.
    if (legacy.error) {
      if (readLegacyProject) readLegacyProject(legacy.projectFile);
      throw legacy.error;
    }
    if (legacy.state === "foreign") {
      if (readLegacyProject) readLegacyProject(legacy.projectFile);
      fail("Project canon does not match this canonical root.", "PROJECT_IDENTITY_MISMATCH");
    }
    return null;
  }
  // Caller-specific original validation may include its selected Session. It
  // runs only after marker ownership/conflict selection; its failure must never
  // turn an owned Project into an unknown sibling or select another root.
  if (selected === legacy && readLegacyProject) readLegacyProject(legacy.projectFile);
  const dialect = selected === legacy ? "head" : "lode";
  const storage = Object.freeze({
    projectRoot,
    projectId: selected.project.projectId,
    dialect,
    directory: dialect === "head" ? ".head" : ".lode",
    projectFile: selected.projectFile,
  });
  markerBases.set(storage, { projectDigest: digest(selected.bytes), location: selected.location });
  return storage;
}

export function assertProjectStorageUnchanged(storage) {
  if (!storage || !markerBases.has(storage)) fail("Expected the selected Project storage basis.", "PROJECT_IDENTITY_MISMATCH");
  // Re-read the selected original first: a known owned failure cannot silently
  // become another dialect or an absent/default Project after selection.
  const bytes = fs.readFileSync(storage.projectFile);
  if (digest(bytes) !== markerBases.get(storage).projectDigest) fail("Project storage changed during the operation.", "PROJECT_IDENTITY_MISMATCH");
  const current = resolveProjectStorage(storage.projectRoot);
  if (!current || current.dialect !== storage.dialect || current.projectId !== storage.projectId) {
    fail("Project storage changed during the operation.", "PROJECT_IDENTITY_MISMATCH");
  }
  return storage;
}

// This is an evidence ownership alias only. Effect/rootDigest/native binding
// checks deliberately do not use it. Every upper selection re-verifies history.
export function projectOwnsRecordedRoot(storage, recordedRoot) {
  const basis = markerBases.get(storage);
  return Boolean(basis && (recordedRoot === storage.projectRoot || basis.location?.roots.includes(recordedRoot)));
}

export function projectCopyRecordWasAdmitted(storage, relative) {
  return Boolean(markerBases.get(storage)?.location?.copyAdmission?.inventory.files.some((entry) => entry.path === relative));
}

export function projectOwnsRecordedRecord(storage, recordedRoot, { path: relative, digest: rawDigest } = {}) {
  if (projectOwnsRecordedRoot(storage, recordedRoot)) return true;
  const admission = markerBases.get(storage)?.location?.copyAdmission;
  const entry = admission?.inventory.files.find((item) => item.path === relative && item.sha256 === rawDigest);
  if (!entry) return false;
  verifyCopiedProjectFile(storage.projectRoot, entry);
  return true;
}

// Called only by the local physical reader after its bounded decode/hydrate.
// A caller-supplied/custom adapter document cannot borrow a copied file scope.
export function noteCopiedSnapshotRead(storage, entry, dependencies = []) {
  const basis = markerBases.get(storage)?.location;
  if (!basis?.copyAdmission || !entry?.document || typeof entry.location !== "string") return entry;
  const relative = path.relative(storage.projectRoot, entry.location).replaceAll("\\", "/");
  const admitted = basis.copyAdmission.inventory.files.find((item) => item.path === relative);
  if (!admitted) return entry;
  verifyCopiedProjectFile(storage.projectRoot, admitted);
  copiedSnapshotReads.set(entry.document, {
    projectRoot: storage.projectRoot,
    admissionDigest: basis.copyAdmissionDigest,
    relative,
    dependencies,
    logicalHash: entry.document.worldModelHash || entry.document.graphSnapshotHash,
  });
  copiedSnapshotEntries.set(entry, entry.document);
  return entry;
}

export function projectOwnsRecordedSnapshot(storage, snapshot, entry = null) {
  if (snapshot?.projectId !== storage?.projectId) return false;
  if (projectOwnsRecordedRoot(storage, snapshot.projectRoot)) return true;
  const admission = markerBases.get(storage)?.location?.copyAdmission;
  if (entry !== null && copiedSnapshotEntries.get(entry) !== snapshot) return false;
  const read = copiedSnapshotReads.get(snapshot);
  if (
    !read ||
    read.projectRoot !== storage.projectRoot ||
    read.admissionDigest !== markerBases.get(storage)?.location?.copyAdmissionDigest ||
    read.logicalHash !== (snapshot.worldModelHash || snapshot.graphSnapshotHash)
  )
    return false;
  const snapshotId = snapshot.worldModelId || snapshot.graphSnapshotId;
  if (!admission || typeof snapshotId !== "string" || !/^(world-model|graph-snapshot)-[a-f0-9]{24}$/.test(snapshotId)) return false;
  const git = copiedGitReads.get(snapshot);
  if (git) {
    return (
      git.snapshotId === snapshotId &&
      verifyCopiedGitRef({
        root: storage.projectRoot,
        directory: storage.directory,
        projectId: storage.projectId,
        dialect: storage.dialect,
        admission,
        owner: git.owner,
        snapshotId,
        treeObjectId: git.treeObjectId,
      })
    );
  }
  const family = snapshot.worldModelId ? "world-model" : "graph-projection";
  const base = `${storage.directory}/${family}/snapshots/${snapshotId}.json`;
  const entries = admission.inventory.files.filter((entry) => entry.path === base || entry.path === `${base}.gz`);
  if (entries.length !== 1 || entries[0].path !== read.relative) return false;
  for (const dependency of read.dependencies) {
    if (!projectOwnsRecordedRecord(storage, snapshot.projectRoot, dependency)) return false;
  }
  // Bundle bytes are pinned inside the existing bounded typed hydrate, not
  // through a second decoder/traversal with different limits.
  verifyCopiedProjectFile(storage.projectRoot, entries[0]);
  return true;
}

// Imported historical authorizations do not inherit a live Host execution
// capability, even when the new PC happens to use the same absolute path.
// Historical private-store identity is read-only evidence. This does not
// change the current store owner used by ensure/write/GC.
function normalSnapshotStoreOwner(storage, owner) {
  const basis = markerBases.get(storage);
  if (!basis || !owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  return [storage.projectRoot, ...(basis.location?.roots || [])].some(
    (root) =>
      JSON.stringify(owner) ===
      JSON.stringify({
        schemaVersion: 1,
        kind: "LocalDerivedSnapshotStore",
        projectId: storage.projectId,
        rootDigest: digest(root),
        dialect: storage.dialect,
        objectFormat: "sha256",
        authority: "derived-evidence-only",
      }),
  );
}
export function projectOwnsSnapshotStoreOwner(storage, owner) {
  return (
    normalSnapshotStoreOwner(storage, owner) ||
    verifyCopiedGitOwner({
      root: storage.projectRoot,
      directory: storage.directory,
      projectId: storage.projectId,
      dialect: storage.dialect,
      admission: markerBases.get(storage)?.location?.copyAdmission,
      owner,
    })
  );
}
export function projectOwnsSnapshotStoreAddress(storage, owner, snapshotId, treeObjectId) {
  return (
    normalSnapshotStoreOwner(storage, owner) ||
    verifyCopiedGitRef({
      root: storage.projectRoot,
      directory: storage.directory,
      projectId: storage.projectId,
      dialect: storage.dialect,
      admission: markerBases.get(storage)?.location?.copyAdmission,
      owner,
      snapshotId,
      treeObjectId,
    })
  );
}

export function projectCopyContainsAuthorization(storage, authorizationId) {
  const admission = markerBases.get(storage)?.location?.copyAdmission;
  return Boolean(admission?.inventory.files.some((entry) => entry.path === `${storage.directory}/runtime/execution-authorizations/${authorizationId}.json`));
}
export function projectBundleWasImported(storage, manifestSha256) {
  const receipt = markerBases.get(storage)?.location?.copyAdmission;
  return receipt?.kind === "PortableProjectAdmission" && receipt.bundleManifestDigest === manifestSha256;
}

export function projectBundleOmittedOriginal(storage, relative) {
  const receipt = markerBases.get(storage)?.location?.copyAdmission;
  return receipt?.kind === "PortableProjectAdmission" && !receipt.inventory.files.some((entry) => entry.path === relative);
}

export function projectLocationBasis(storage) {
  return markerBases.get(storage)?.location?.digest ?? null;
}

// Trusted local Git reader only, after verified content-addressed tree/blobs.
export function noteCopiedGitSnapshotRead(storage, entry, owner) {
  const basis = markerBases.get(storage)?.location,
    admission = basis?.copyAdmission;
  const snapshot = entry?.document,
    snapshotId = snapshot?.worldModelId || snapshot?.graphSnapshotId;
  if (
    !admission ||
    !snapshot ||
    !verifyCopiedGitRef({
      root: storage.projectRoot,
      directory: storage.directory,
      projectId: storage.projectId,
      dialect: storage.dialect,
      admission,
      owner,
      snapshotId,
      treeObjectId: entry.snapshotStorage?.treeObjectId,
    })
  )
    return entry;
  copiedSnapshotReads.set(snapshot, {
    projectRoot: storage.projectRoot,
    admissionDigest: basis.copyAdmissionDigest,
    logicalHash: snapshot.worldModelHash || snapshot.graphSnapshotHash,
  });
  copiedSnapshotEntries.set(entry, snapshot);
  copiedGitReads.set(snapshot, { owner: structuredClone(owner), snapshotId, treeObjectId: entry.snapshotStorage.treeObjectId });
  return entry;
}
