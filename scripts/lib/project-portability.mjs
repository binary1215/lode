import { withSnapshotReferences } from "./snapshot-reference-lifetime.mjs";
import { PORTABLE_SOURCE_CAPABILITY, validatePortableManifestFormat, verifyPortableSourceReferenceClosure } from "./portable-project-format.mjs";
import { collectPortableSourceOriginals, verifyPortableSourceObjects } from "./portable-source-originals.mjs";
import { buildProjectHandoff, readBundleHandoff, validateProjectHandoffDescriptor } from "./project-handoff.mjs";
import { verifyImportedDefaultRun } from "./session-imported-run-proof.mjs";
import fs from "node:fs";
import path from "node:path";
import { buildCurrentInstallationProjections, inspectProject } from "./lode-core.mjs";
import { resolveProjectStorage, projectBundleWasImported } from "./project-storage-format.mjs";
import { withLocalMutation, withProjectMutation } from "./project-mutation-lock.mjs";
import { withSessionRoute } from "./session-routing.mjs";
import { PORTABLE_PROJECT_LOCATION_KIND } from "./project-portable-proof.mjs";
import { readGraphProject } from "./discovery-index.mjs";
import { verifyImportedDefaultSession } from "./session-import-proof.mjs";
import { verifySessionWorkEvidenceOriginal } from "./session-work-evidence-original.mjs";
import { assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { sessionStatePath } from "./session-routing.mjs";
import { inspectCopiedProjectCanon, verifySelectedProjectOriginals, verifyProjectMetadataOriginal } from "./project-copy-canon.mjs";
import { copyOriginal, copiedProjectFile, inspectCopiedProjectFile, verifyCopiedProjectFile, readCopiedProjectExcerpt } from "./project-copy-evidence.mjs";
import { readProjectDirection } from "./project-direction.mjs";
import { verifyProjectLocation, verifyProjectLocationOriginals } from "./project-location-proof.mjs";
import { atomicCreateArtifact } from "./core/fs-atomic.mjs";
import { readBoundedSnapshotDescriptor, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { sha256Hex as sha } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const check = (signal) => {
  if (signal?.aborted) fail("PROJECT_PORTABILITY_CANCELLED");
};
const contained = (base, file) => {
  const relative = path.relative(base, file);
  return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};

function boundedJson(root, relative) {
  const file = copiedProjectFile(root, relative),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("PROJECT_BUNDLE_MANIFEST_UNSAFE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail("PROJECT_COPY_SOURCE_CHANGED");
    const bytes = readBoundedSnapshotDescriptor(fd, stat.size, SNAPSHOT_STORAGE_LIMITS.decodedBytes),
      after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail("PROJECT_COPY_SOURCE_CHANGED");
    return {
      bytes,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function objectPath(entry) {
  return "objects/" + entry.sha256 + ".bin";
}
function exactCreate(root, relative, bytes) {
  const file = copiedProjectFile(root, relative);
  if (fs.existsSync(file)) {
    const current = inspectCopiedProjectFile(root, relative);
    if (current.bytes !== bytes.length || current.sha256 !== sha(bytes)) fail("PROJECT_BUNDLE_CONFLICT");
    return;
  }
  atomicCreateArtifact(file, bytes);
}

export const DEFAULT_PROJECT_PROVENANCE_SCOPE = "project-proof-metadata";

function exportProjectBundleUncoordinated({
  root = ".",
  destination,
  signal,
  onObject = null,
  onExportScope = null,
  provenanceScope = DEFAULT_PROJECT_PROVENANCE_SCOPE,
  sourceMode = "selected-retained-sources",
} = {}) {
  if (!["selected-only", "project-proof-metadata"].includes(provenanceScope)) fail("PROJECT_BUNDLE_PROVENANCE_SCOPE_INVALID");
  if (!["selected-retained-sources", "refs-only"].includes(sourceMode)) fail("PROJECT_BUNDLE_SOURCE_MODE_INVALID");
  check(signal);
  const inspected = readGraphProject(root);
  if (!inspected.project) fail("NOT_INITIALIZED");
  const storage = inspected.storage,
    sourceRoot = storage.projectRoot,
    directory = storage.directory,
    stateFile = sessionStatePath(sourceRoot, storage);
  verifyProjectLocation(sourceRoot, directory, inspected.project);
  const stateRelative = path.relative(sourceRoot, stateFile).replaceAll("\\", "/");
  const stateOriginal = boundedJson(sourceRoot, stateRelative),
    state = stateOriginal.value;
  const canon = inspectCopiedProjectCanon({
    root: sourceRoot,
    directory,
    project: inspected.project,
    selectedSession: { sessionId: state.sessionId, stateFile },
  });
  if (canon.originals.find((entry) => entry.path === stateRelative)?.sha256 !== sha(stateOriginal.bytes)) fail("PROJECT_COPY_SOURCE_CHANGED");
  const filesByPath = new Map(canon.originals.map((entry) => [entry.path, entry]));
  const omittedRunOwnerProof = canon.runOwnerGlobalMetadata && provenanceScope === "selected-only";
  if (omittedRunOwnerProof) for (const relative of canon.runOwnerOriginals) filesByPath.delete(relative);
  const ownerOriginals = new Map();
  let ownerGlobalMetadata = false;
  const needsOwnerProof = state.projectId == null && stateRelative !== directory + "/sessions/current.json";
  if (needsOwnerProof) {
    const valid = verifyImportedDefaultSession({
      root: sourceRoot,
      directory,
      project: inspected.project,
      sessionId: state.sessionId,
      stateFile,
      stateBytes: stateOriginal.bytes,
      onOriginal(relative, bytes, document) {
        ownerOriginals.set(relative, {
          path: relative,
          bytes: bytes.length,
          sha256: sha(bytes),
        });
        if (
          document?.kind === "VerifiedProjectCopyAdmission" ||
          (document?.kind === "PortableProjectAdmission" && document.selectedSessionId !== state.sessionId)
        )
          ownerGlobalMetadata = true;
      },
    });
    if (!valid) fail("SESSION_IDENTITY_MISMATCH");
  }
  const omittedOwnerProof = needsOwnerProof && (ownerGlobalMetadata || canon.runOwnerGlobalMetadata) && provenanceScope === "selected-only";
  if (!omittedOwnerProof) for (const entry of ownerOriginals.values()) filesByPath.set(entry.path, entry);
  const add = (relative) => {
    check(signal);
    const observed = inspectCopiedProjectFile(sourceRoot, relative, { signal });
    filesByPath.set(relative, observed);
    return observed;
  };
  add(directory + "/project.json");
  if (fs.existsSync(copiedProjectFile(sourceRoot, directory + "/instructions/project.md"))) add(directory + "/instructions/project.md");
  const workRecords = [];
  const workDirectory = path.posix.dirname(stateRelative) + "/work-evidence",
    workPath = copiedProjectFile(sourceRoot, workDirectory);
  if (fs.existsSync(workPath))
    for (const name of fs.readdirSync(workPath).sort()) {
      if (!/^work-evidence-[a-f0-9]{24}\.json$/.test(name)) continue;
      const relative = workDirectory + "/" + name,
        entry = add(relative),
        raw = fs.readFileSync(copiedProjectFile(sourceRoot, relative));
      if (sha(raw) !== entry.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
      workRecords.push(
        verifySessionWorkEvidenceOriginal({
          owner: { projectId: storage.projectId, sessionId: canon.sessionId, storage },
          evidenceId: name.slice(0, -5),
          bytes: raw,
        }),
      );
    }
  const sourceCollection = collectPortableSourceOriginals({
    root: sourceRoot,
    storage,
    project: inspected.project,
    sessionId: canon.sessionId,
    records: workRecords,
    mode: sourceMode,
    signal,
  });
  for (const entry of sourceCollection.files) filesByPath.set(entry.path, entry);
  // Only the selected Project's declared location proof is common closure.
  // No generated manifest/config, cache or unrelated Session directory is read.
  const omittedCommonProof = Boolean(inspected.project.location?.admissionDigest) && provenanceScope === "selected-only";
  let original = inspected.project;
  const proofSeen = new Set();
  while (original.location && !omittedCommonProof) {
    const location = original.location;
    if (
      typeof location.previousProjectDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(location.previousProjectDigest) ||
      proofSeen.has(location.previousProjectDigest)
    )
      fail("PROJECT_LOCATION_IDENTITY_MISMATCH");
    proofSeen.add(location.previousProjectDigest);
    if (location.admissionDigest) {
      const portable = location.kind === PORTABLE_PROJECT_LOCATION_KIND;
      const receiptPath = directory + "/project-location/" + (portable ? "portable/" : "copies/") + location.admissionDigest + ".json";
      const receipt = boundedJson(sourceRoot, receiptPath).value;
      add(receiptPath);
      add(
        directory +
          "/project-location/" +
          (portable ? "portable-bundles/" + receipt.bundleManifestDigest : "copy-originals/" + receipt.sourceManifestDigest) +
          ".json",
      );
    }
    const predecessor = directory + "/project-location/history/" + location.previousProjectDigest + ".json";
    add(predecessor);
    original = boundedJson(sourceRoot, predecessor).value;
  }
  const files = [...filesByPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schemaVersion: 2,
    requiredCapabilities: [PORTABLE_SOURCE_CAPABILITY],
    sourceTransfer: sourceCollection.transfer,
    kind: "PortableProjectBundle",
    authorityPlane: "P3",
    projectId: storage.projectId,
    directory,
    sourceProjectDigest: sha(fs.readFileSync(storage.projectFile)),
    selectedSessionId: canon.sessionId,
    selectedSessionPath: stateRelative,
    selection: "current-request-logical-session",
    files,
    excludedPaths: [],
    coverage: {
      selectedCanonAndP2: "typed-original-reference-closure-verified",
      selectedWorkEvidence: "typed-originals-verified",
      selectedRunOwnerProof: omittedRunOwnerProof ? "omitted-global-inventory-metadata" : "included-or-not-needed",
      sourceLocationProof: omittedCommonProof ? "omitted-global-inventory-metadata" : "included",
      selectedSessionOwnerProof: omittedOwnerProof
        ? "omitted-global-inventory-metadata"
        : needsOwnerProof
          ? "included-exact-default-mapping"
          : "direct-project-identity",
      otherSessions:
        provenanceScope === "project-proof-metadata" && (inspected.project.location?.admissionDigest || ownerGlobalMetadata || canon.runOwnerGlobalMetadata)
          ? "payloads-not-included-common-proof-metadata-included"
          : "not-read-not-included",
      generatedSettings: "not-read-not-included-use-current-installation",
      derivedCaches: "not-read-not-included",
      historicalExecution: "not-included-no-execution-permission-transferred",
      repositoryWorktree: "not-included",
      retainedSourceOriginals: sourceCollection.transfer,
      exactDiffPortability: sourceCollection.transfer.references.every((ref) => ref.status === "included-verified-retained-original")
        ? "selected-source-bytes-included-diff-not-yet-queried"
        : "partial-selected-source-bytes",
      attachments: "not-included-unless-explicitly-selected",
      nativeHistory: "not-requested",
    },
    restoresExecutionPermission: false,
    transfersNativeBinding: false,
  };
  const handoff = buildProjectHandoff({
    manifest,
    readOriginal: (entry) => readCopiedProjectExcerpt(sourceRoot, entry, { maxBytes: Math.max(1, entry.bytes), signal }).bytes,
  });
  manifest.handoff = handoff.descriptor;
  const encoded = json(manifest),
    manifestSha256 = sha(encoded),
    bundleId = "project-bundle-" + manifestSha256.slice(0, 24);
  if (typeof destination !== "string" || !destination.trim()) fail("PROJECT_BUNDLE_DESTINATION_REQUIRED");
  const parent = fs.realpathSync(path.dirname(path.resolve(destination))),
    bundleRoot = copiedProjectFile(parent, path.basename(path.resolve(destination)));
  if (contained(path.join(sourceRoot, directory), bundleRoot)) fail("PROJECT_BUNDLE_DESTINATION_INSIDE_SOURCE");
  const exportScope = Object.freeze({
    kind: "ProjectExportScope",
    authorityPlane: "P4",
    persisted: false,
    provenanceScope,
    sourceMode,
    retainedSourceOriginals: sourceCollection.transfer,
    sourceNotice:
      "Before export: eligible exact full-file retained originals cited by this selected Session are included by default. Current worktree, other Session bodies and Git-only collection are excluded. Choose refs-only to omit source bodies. Source identity is not producer truth or execution permission; exclusions remain per-reference partial.",
    commonProofMetadata: provenanceScope === "project-proof-metadata" ? "required-original-path-id-hash-metadata" : "cross-session-proof-metadata-excluded",
    requiredProofMayMentionOtherSessions:
      provenanceScope === "project-proof-metadata" &&
      Boolean(inspected.project.location?.admissionDigest || ownerGlobalMetadata || canon.runOwnerGlobalMetadata),
    otherSessionBodiesIncluded: false,
    userConfigurationIncluded: false,
    executionPermissionTransferred: false,
    message:
      provenanceScope === "project-proof-metadata"
        ? "Before export: recovery-required common proof may include other Sessions' paths, IDs and hashes. Other Session bodies and user configuration are excluded. Use selected-only to omit cross-session proof metadata; legacy admission may then remain partial."
        : "Before export: cross-session proof metadata is excluded. Other Session bodies and user configuration are excluded. Missing legacy proof remains partial rather than being rewritten.",
  });
  if (onExportScope !== null) {
    if (typeof onExportScope !== "function") fail("PROJECT_EXPORT_SCOPE_OBSERVER_INVALID");
    const shown = onExportScope(exportScope);
    if (shown && typeof shown.then === "function") {
      Promise.resolve(shown).catch(() => {});
      fail("PROJECT_EXPORT_SCOPE_OBSERVER_MUST_BE_SYNCHRONOUS");
    }
  }
  check(signal);
  if (!fs.existsSync(bundleRoot)) fs.mkdirSync(bundleRoot);
  if (!fs.lstatSync(bundleRoot).isDirectory()) fail("PROJECT_BUNDLE_DESTINATION_INVALID");
  const intentFile = copiedProjectFile(bundleRoot, "export-intent.json");
  if (!fs.existsSync(intentFile) && fs.readdirSync(bundleRoot).length) fail("PROJECT_BUNDLE_DESTINATION_NOT_EMPTY");
  exactCreate(bundleRoot, "export-intent.json", json({ schemaVersion: 1, kind: "ProjectBundleExportIntent", bundleId, manifestSha256 }));
  const objects = copiedProjectFile(bundleRoot, "objects");
  if (!fs.existsSync(objects)) fs.mkdirSync(objects);
  for (const entry of files) copyOriginal(sourceRoot, bundleRoot, entry, { signal, onObject });
  for (const entry of files) verifyCopiedProjectFile(sourceRoot, entry);
  assertProjectStorageUnchanged(storage);
  check(signal);
  // Preserve an edited or independently supplied explanation. It cannot block
  // verified common originals or be mistaken for the generated projection.
  let handoffPublicationFailure = null;
  try {
    const file = copiedProjectFile(bundleRoot, "HANDOFF.md");
    if (!fs.existsSync(file)) atomicCreateArtifact(file, handoff.bytes);
  } catch (error) {
    if (error.code !== "EEXIST")
      handoffPublicationFailure = { code: error.code || "PROJECT_HANDOFF_PUBLICATION_FAILED", message: String(error.message).slice(0, 1024) };
  }
  exactCreate(bundleRoot, "manifest.json", encoded);
  return {
    status: omittedCommonProof || omittedOwnerProof || omittedRunOwnerProof ? "exported-partial-provenance" : "exported",
    projectAdmissionReady: !omittedCommonProof && !omittedOwnerProof && !omittedRunOwnerProof,
    bundleId,
    bundleRoot,
    manifestSha256,
    fileCount: files.length,
    handoff: {
      ...readBundleHandoff({ bundleRoot, manifest, signal }),
      ...(handoffPublicationFailure ? { primaryPublicationFailure: handoffPublicationFailure } : {}),
    },
    exportScope,
    coverage: manifest.coverage,
    authorityPlane: "P3",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}

export function inspectProjectBundle({ bundleRoot, expectedBundleId = null, signal, handoffOptions = {} } = {}) {
  check(signal);
  const root = fs.realpathSync(path.resolve(bundleRoot));
  const { value: manifest, bytes } = boundedJson(root, "manifest.json"),
    manifestSha256 = sha(bytes),
    bundleId = "project-bundle-" + manifestSha256.slice(0, 24);
  const intent = boundedJson(root, "export-intent.json").value;
  if (
    intent?.schemaVersion !== 1 ||
    intent.kind !== "ProjectBundleExportIntent" ||
    intent.bundleId !== bundleId ||
    intent.manifestSha256 !== manifestSha256 ||
    (expectedBundleId !== null && expectedBundleId !== bundleId)
  )
    fail("PROJECT_BUNDLE_IDENTITY_MISMATCH");
  if (
    ![1, 2].includes(manifest?.schemaVersion) ||
    manifest.kind !== "PortableProjectBundle" ||
    manifest.authorityPlane !== "P3" ||
    ![".lode", ".head"].includes(manifest.directory) ||
    typeof manifest.projectId !== "string" ||
    typeof manifest.selectedSessionId !== "string" ||
    !/^session-[a-fA-F0-9-]{36}$/.test(manifest.selectedSessionId) ||
    typeof manifest.selectedSessionPath !== "string" ||
    manifest.selection !== "current-request-logical-session" ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.excludedPaths) ||
    manifest.restoresExecutionPermission !== false ||
    manifest.transfersNativeBinding !== false
  )
    fail("PROJECT_BUNDLE_MANIFEST_INVALID");
  validatePortableManifestFormat(manifest);
  const names = new Set(),
    entries = new Map();
  for (const entry of manifest.files) {
    check(signal);
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      names.has(entry.path.toLowerCase())
    )
      fail("PROJECT_BUNDLE_MANIFEST_INVALID");
    copiedProjectFile(root, entry.path);
    names.add(entry.path.toLowerCase());
    entries.set(entry.path, entry);
    if (!entry.path.startsWith(manifest.directory + "/")) fail("PROJECT_BUNDLE_SCOPE_MISMATCH");
    verifyCopiedProjectFile(root, { ...entry, path: objectPath(entry) });
  }
  const allowed = new Set(),
    originalBytes = (relative) => {
      const entry = entries.get(relative);
      if (!entry) fail("PROJECT_BUNDLE_REFERENCE_MISSING");
      allowed.add(relative);
      return boundedJson(root, objectPath(entry)).bytes;
    },
    read = (relative) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(originalBytes(relative)));
  const projectPath = manifest.directory + "/project.json",
    projectEntry = entries.get(projectPath);
  if (!projectEntry || projectEntry.sha256 !== manifest.sourceProjectDigest) fail("PROJECT_BUNDLE_MANIFEST_INVALID");
  const project = verifyProjectMetadataOriginal(read(projectPath), manifest.directory);
  if (project.projectId !== manifest.projectId) fail("PROJECT_BUNDLE_IDENTITY_MISMATCH");
  const partialProvenance = manifest.coverage?.sourceLocationProof === "omitted-global-inventory-metadata";
  if (partialProvenance) {
    const location = project.location;
    if (
      !["verified-project-copy", PORTABLE_PROJECT_LOCATION_KIND].includes(location?.kind) ||
      typeof location.admissionDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(location.admissionDigest) ||
      typeof location.previousProjectDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(location.previousProjectDigest)
    )
      fail("PROJECT_BUNDLE_MANIFEST_INVALID");
  } else {
    if (manifest.coverage?.sourceLocationProof !== "included") fail("PROJECT_BUNDLE_MANIFEST_INVALID");
    verifyProjectLocationOriginals({
      directory: manifest.directory,
      project,
      readOriginal: originalBytes,
    });
  }
  const selectedState = read(manifest.selectedSessionPath);
  const unkeyedNamed = selectedState.projectId == null && manifest.selectedSessionPath !== manifest.directory + "/sessions/current.json";
  const partialOwner = manifest.coverage?.selectedSessionOwnerProof === "omitted-global-inventory-metadata";
  if (unkeyedNamed && !partialOwner) {
    const stateBytes = originalBytes(manifest.selectedSessionPath);
    // The source layout is retained exactly; no fake Core owner is registered.
    verifyBundledDefaultOwner({
      root,
      manifest,
      entries,
      allowed,
      sourceStateBytes: stateBytes,
    });
  }
  const partialRunOwner = manifest.coverage?.selectedRunOwnerProof === "omitted-global-inventory-metadata";
  const selected = verifySelectedProjectOriginals({
    directory: manifest.directory,
    project,
    selectedSessionPath: manifest.selectedSessionPath,
    selectedSessionId: manifest.selectedSessionId,
    verifyRunOwner(runId, run) {
      if (partialRunOwner) return true;
      return verifyBundledRunOwner({ root, manifest, entries, allowed, runId, run });
    },
    read,
    has: (relative) => entries.has(relative),
    list: (relative) => [...entries.keys()].filter((name) => name.startsWith(relative + "/")).map((name) => name.slice(relative.length + 1)),
  });
  const instruction = manifest.directory + "/instructions/project.md";
  if (entries.has(instruction)) allowed.add(instruction);
  const workRecords = [];
  const workDirectory = path.posix.dirname(manifest.selectedSessionPath) + "/work-evidence/";
  for (const entry of entries.values())
    if (entry.path.startsWith(workDirectory) && /^work-evidence-[a-f0-9]{24}\.json$/.test(entry.path.slice(workDirectory.length))) {
      if (entry.bytes > 64 * 1024) fail("INVALID_SESSION_WORK_EVIDENCE");
      const raw = originalBytes(entry.path);
      workRecords.push(
        verifySessionWorkEvidenceOriginal({
          owner: {
            projectId: project.projectId,
            sessionId: selected.sessionId,
            storage: {
              dialect: manifest.directory === ".lode" ? "lode" : "head",
              directory: manifest.directory,
            },
          },
          evidenceId: path.posix.basename(entry.path).slice(0, -5),
          bytes: raw,
        }),
      );
    }
  verifyPortableSourceReferenceClosure(manifest, workRecords);
  for (const relative of verifyPortableSourceObjects({ root, manifest, readOriginal: originalBytes })) allowed.add(relative);
  for (const relative of entries.keys()) if (!allowed.has(relative)) fail("PROJECT_BUNDLE_SCOPE_MISMATCH");
  validateProjectHandoffDescriptor(manifest);
  return {
    status: partialProvenance || partialOwner || partialRunOwner ? "verified-selected-originals-partial-provenance" : "verified-selected-bundle",
    projectAdmissionReady: !partialProvenance && !partialOwner && !partialRunOwner,
    bundleId,
    bundleRoot: root,
    manifestSha256,
    manifest,
    handoff: readBundleHandoff({ bundleRoot: root, manifest, signal, ...handoffOptions }),
    coverage: {
      selectedSession: "typed-original-reference-closure-verified",
      retainedSourceOriginals: manifest.sourceTransfer || { status: "not-recorded-not-certified", gitLookup: "not-looked-up-not-included" },
      exactDiff: "not-yet-queried",
      sourceLocationProof: partialProvenance ? "partial-not-project-admission" : "verified",
      operationalCapabilities: "excluded",
      otherSessions: project.location?.admissionDigest && !partialProvenance ? "payloads-excluded-common-proof-metadata-included" : "excluded",
      generatedSettings: "excluded",
      nativeHistory: "not-requested",
    },
    authorityPlane: "P4",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    transfersNativeBinding: false,
  };
}

function portableImportPlan({ inspected, root, pluginRoot, createdAt }) {
  const { manifest, bundleRoot, manifestSha256, bundleId } = inspected,
    directory = manifest.directory;
  if (!inspected.projectAdmissionReady) fail("PROJECT_BUNDLE_PROVENANCE_INCOMPLETE");
  const sourceEntry = manifest.files.find((item) => item.path === directory + "/project.json");
  const sourceBytes = fs.readFileSync(copiedProjectFile(bundleRoot, objectPath(sourceEntry)));
  if (sha(sourceBytes) !== sourceEntry.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
  const source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes));
  const receipt = {
    schemaVersion: 1,
    kind: "PortableProjectAdmission",
    authorityPlane: "P3",
    projectId: manifest.projectId,
    directory,
    targetRoot: root,
    sourceProjectDigest: manifest.sourceProjectDigest,
    bundleManifestDigest: manifestSha256,
    selectedSessionId: manifest.selectedSessionId,
    origin:
      verifyProjectLocationOriginals({
        directory,
        project: source,
        readOriginal: (relative) => {
          const entry = manifest.files.find((item) => item.path === relative);
          if (!entry) fail("PROJECT_BUNDLE_REFERENCE_MISSING");
          return fs.readFileSync(copiedProjectFile(bundleRoot, objectPath(entry)));
        },
      }).origin || "origin-verified",
    inventory: {
      files: manifest.files,
      excludedPaths: [],
      integrity: "raw-byte-inventory-only",
      grantsOwnership: false,
    },
    grantsExecutionAuthorization: false,
  };
  const receiptBytes = json(receipt),
    admissionDigest = sha(receiptBytes);
  const projectBytes = json({
    ...source,
    projectRoot: root,
    location: {
      kind: PORTABLE_PROJECT_LOCATION_KIND,
      admissionDigest,
      previousProjectDigest: manifest.sourceProjectDigest,
    },
  });
  const installation = buildCurrentInstallationProjections({
    projectRoot: root,
    pluginRoot,
    directory,
  });
  const generated = new Map([...installation.files].map(([relative, value]) => [relative, Buffer.from(value)]));
  generated.set(directory + "/project-location/history/" + manifest.sourceProjectDigest + ".json", sourceBytes);
  generated.set(directory + "/project-location/portable-bundles/" + manifestSha256 + ".json", fs.readFileSync(copiedProjectFile(bundleRoot, "manifest.json")));
  generated.set(directory + "/project-location/portable/" + admissionDigest + ".json", receiptBytes);
  const managed = [
    { path: directory + "/project.json", sha256: sha(projectBytes) },
    ...[...installation.files].map(([relative, value]) => ({
      path: relative,
      sha256: sha(Buffer.from(value)),
    })),
  ];
  generated.set(
    directory + "/generated/manifest.json",
    json({
      schemaVersion: 1,
      generatedAt: createdAt,
      pluginRoot: installation.pluginRoot,
      packageVersion: installation.packageVersion,
      integrationPolicy: installation.rootIntegrationPolicy,
      restoredFromBundle: bundleId,
      managed,
    }),
  );
  generated.set(directory + "/project.json", projectBytes);
  const originals = manifest.files.filter((item) => item.path !== directory + "/project.json");
  return {
    directory,
    selectedSessionId: manifest.selectedSessionId,
    projectId: manifest.projectId,
    pluginRoot: installation.pluginRoot,
    packageVersion: installation.packageVersion,
    originals,
    generated,
    admissionDigest,
  };
}

export function importProjectBundle({ bundleRoot, root, pluginRoot, expectedBundleId = null, signal, onPublication = null } = {}) {
  const inspected = inspectProjectBundle({ bundleRoot, expectedBundleId, signal });
  if (!inspected.projectAdmissionReady) fail("PROJECT_BUNDLE_PROVENANCE_INCOMPLETE");
  const targetRoot = fs.realpathSync(path.resolve(root)),
    directory = inspected.manifest.directory;
  if (contained(path.join(targetRoot, directory), inspected.bundleRoot) || contained(inspected.bundleRoot, targetRoot))
    fail("PROJECT_BUNDLE_SOURCE_TARGET_OVERLAP");
  const pendingRelative = directory + "/project-location/pending.json",
    pendingFile = copiedProjectFile(targetRoot, pendingRelative);
  const readPending = () => (fs.existsSync(pendingFile) ? boundedJson(targetRoot, pendingRelative) : null);
  const initialPending = readPending();
  const createdAt = initialPending?.value.createdAt || new Date().toISOString();
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) fail("PROJECT_BUNDLE_IMPORT_INTENT_INVALID");
  const plan = portableImportPlan({ inspected, root: targetRoot, pluginRoot, createdAt });
  const summary = {
    kind: "ProjectPortabilityPublication",
    schemaVersion: 1,
    targetRoot,
    bundleId: inspected.bundleId,
    manifestSha256: inspected.manifestSha256,
    bundleRoot: initialPending?.value.bundleRoot || inspected.bundleRoot,
    projectId: plan.projectId,
    selectedSessionId: plan.selectedSessionId,
    createdAt,
    pluginRoot: plan.pluginRoot,
    packageVersion: plan.packageVersion,
    originals: plan.originals,
    generated: [...plan.generated].map(([relative, bytes]) => ({
      path: relative,
      bytes: bytes.length,
      sha256: sha(bytes),
    })),
  };
  const pendingBytes = json(summary);
  if (initialPending && !initialPending.bytes.equals(pendingBytes)) fail("PROJECT_BUNDLE_IMPORT_INTENT_CONFLICT");
  const projectFile = copiedProjectFile(targetRoot, directory + "/project.json");
  // Never reinterpret a damaged/foreign existing Project as an empty target.
  if (!initialPending) {
    const current = resolveProjectStorage(targetRoot);
    if (current) {
      if (current.projectId !== plan.projectId || current.directory !== directory) fail("PROJECT_BUNDLE_TARGET_PROJECT_CONFLICT");
      if (projectBundleWasImported(current, inspected.manifestSha256)) {
        let identical = true;
        for (const entry of inspected.manifest.files) {
          if (entry.path === directory + "/project.json") continue;
          try {
            verifyCopiedProjectFile(targetRoot, entry);
          } catch (error) {
            if (!["ENOENT", "PROJECT_COPY_SOURCE_CHANGED"].includes(error.code)) throw error;
            identical = false;
            break;
          }
        }
        if (identical)
          return {
            status: "existing-project-originals-identical",
            bundleId: inspected.bundleId,
            projectId: plan.projectId,
            selectedSessionId: plan.selectedSessionId,
            targetRoot,
            persisted: false,
            sourceTransfer: {
              coverage: inspected.manifest.sourceTransfer || { status: "not-recorded-not-certified" },
              destinationOriginals: "verified-identical",
              exactDiff: "not-yet-queried",
            },
            defaultSessionChanged: false,
            restoresExecutionPermission: false,
            nativeBindingTransferred: false,
          };
      }
      return importSelectedSessionIntoExisting({
        inspected,
        targetRoot,
        storage: current,
        signal,
        onPublication,
      });
    }
    if (fs.existsSync(projectFile)) fail("PROJECT_BUNDLE_TARGET_PROJECT_CONFLICT");
  }
  const expected = [
    ...plan.originals,
    ...[...plan.generated].map(([relative, bytes]) => ({
      path: relative,
      bytes: bytes.length,
      sha256: sha(bytes),
    })),
  ];
  const verifyExisting = () => {
    for (const entry of expected) {
      check(signal);
      const file = copiedProjectFile(targetRoot, entry.path);
      if (fs.existsSync(file)) verifyCopiedProjectFile(targetRoot, entry);
    }
  };
  verifyExisting();
  return withLocalMutation(
    {
      directory: copiedProjectFile(targetRoot, directory + "/.operations/project-import.lock"),
    },
    () => {
      const currentPending = readPending();
      if (currentPending && !currentPending.bytes.equals(pendingBytes)) fail("PROJECT_BUNDLE_IMPORT_INTENT_CONFLICT");
      if (!currentPending && fs.existsSync(projectFile)) fail("PROJECT_BUNDLE_TARGET_PROJECT_CONFLICT");
      verifyExisting();
      check(signal);
      exactCreate(targetRoot, pendingRelative, pendingBytes);
      for (const entry of plan.originals) {
        const target = copiedProjectFile(targetRoot, entry.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copiedProjectFile(targetRoot, entry.path);
        copyOriginal(inspected.bundleRoot, targetRoot, entry, {
          signal,
          sourceRelative: objectPath(entry),
          targetRelative: entry.path,
        });
        onPublication?.("record", entry.path);
      }
      const finish = () => {
        for (const entry of expected) verifyCopiedProjectFile(targetRoot, entry);
        if (!fs.readFileSync(pendingFile).equals(pendingBytes)) fail("PROJECT_BUNDLE_IMPORT_INTENT_CONFLICT");
        const targetStateEntry = expected.find((entry) => entry.path === inspected.manifest.selectedSessionPath);
        const targetStateBytes = fs.readFileSync(copiedProjectFile(targetRoot, targetStateEntry.path)),
          targetState = JSON.parse(targetStateBytes);
        if (
          targetState.projectId == null &&
          targetStateEntry.path !== directory + "/sessions/current.json" &&
          !verifyImportedDefaultSession({
            root: targetRoot,
            directory,
            project: JSON.parse(plan.generated.get(directory + "/project.json")),
            sessionId: plan.selectedSessionId,
            stateFile: copiedProjectFile(targetRoot, targetStateEntry.path),
            stateBytes: targetStateBytes,
          })
        )
          fail("SESSION_IDENTITY_MISMATCH");
        check(signal);
        fs.unlinkSync(pendingFile);
        return withSnapshotReferences({ root: targetRoot }, () => {
          const restored = withSessionRoute(targetRoot, plan.selectedSessionId, () => inspectProject(targetRoot));
          if (restored.status !== "ready") fail("PROJECT_BUNDLE_IMPORT_NOT_READY");
          return {
            status: "imported",
            bundleId: inspected.bundleId,
            projectId: plan.projectId,
            selectedSessionId: plan.selectedSessionId,
            targetRoot,
            admissionDigest: plan.admissionDigest,
            sourceTransfer: {
              coverage: inspected.manifest.sourceTransfer || { status: "not-recorded-not-certified" },
              destinationOriginals: "verified-copied",
              exactDiff: "not-yet-queried",
            },
            defaultSessionChanged: false,
            restoresExecutionPermission: false,
            nativeBindingTransferred: false,
            rootSettings: "preserved-unowned-not-imported",
            nativeHistory: "not-requested",
            worktree: "not-imported",
          };
        });
      };
      for (const [relative, bytes] of plan.generated) {
        check(signal);
        exactCreate(targetRoot, relative, bytes);
        // The pending import keeps this namespace ineligible for collection.
        onPublication?.(relative === directory + "/project.json" ? "project" : "generated", relative);
      }
      return finish();
    },
  );
}

export function inspectPendingProjectImport({ root } = {}) {
  const targetRoot = fs.realpathSync(path.resolve(root));
  for (const directory of [".lode", ".head"]) {
    const relative = directory + "/project-location/pending.json",
      file = copiedProjectFile(targetRoot, relative);
    if (!fs.existsSync(file)) continue;
    const { value } = boundedJson(targetRoot, relative);
    if (value.kind !== "ProjectPortabilityPublication") continue;
    if (
      value.schemaVersion !== 1 ||
      value.targetRoot !== targetRoot ||
      typeof value.bundleId !== "string" ||
      !/^project-bundle-[a-f0-9]{24}$/.test(value.bundleId) ||
      typeof value.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
      value.bundleId !== "project-bundle-" + value.manifestSha256.slice(0, 24)
    )
      fail("PROJECT_BUNDLE_IMPORT_INTENT_INVALID");
    return {
      status: "project_import_pending",
      authorityPlane: "P4",
      projectRoot: targetRoot,
      bundleId: value.bundleId,
      bundleRootHint: typeof value.bundleRoot === "string" ? value.bundleRoot : null,
      sourceReadAuthority: false,
      requestedProjectId: value.projectId,
      requestedSessionId: value.selectedSessionId,
      verification: "pending-intent-only",
      persisted: false,
      restored: false,
      restoresExecutionPermission: false,
      defaultSessionChanged: false,
    };
  }
  return null;
}

export function projectBundleSummary(inspected) {
  return {
    status: inspected.status,
    bundleId: inspected.bundleId,
    bundleRoot: inspected.bundleRoot,
    manifestSha256: inspected.manifestSha256,
    projectId: inspected.manifest.projectId,
    selectedSessionId: inspected.manifest.selectedSessionId,
    fileCount: inspected.manifest.files.length,
    handoff: inspected.handoff ?? { status: "handoff-not-included" },
    projectAdmissionReady: inspected.projectAdmissionReady,
    coverage: inspected.coverage,
    authorityPlane: "P4",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    transfersNativeBinding: false,
  };
}

function importSelectedSessionIntoExisting({ inspected, targetRoot, storage, signal, onPublication }) {
  const { manifest, bundleRoot, bundleId, manifestSha256 } = inspected;
  // Validate current common direction, but never replace it with the source.
  readProjectDirection({ root: targetRoot, storage });
  const sourceSelectedPath = manifest.selectedSessionPath;
  const sourceSessionDirectory = path.posix.dirname(sourceSelectedPath);
  const sourceStateEntry = manifest.files.find((entry) => entry.path === sourceSelectedPath);
  const state = boundedJson(bundleRoot, objectPath(sourceStateEntry)).value;
  const sourceDefaultFormat = sourceSelectedPath === storage.directory + "/sessions/current.json";
  if (state.projectId != null && state.projectId !== storage.projectId) fail("SESSION_IDENTITY_MISMATCH");
  const ownerProofPaths = new Set();
  if (state.projectId == null && !sourceDefaultFormat) {
    verifyBundledDefaultOwner({
      root: bundleRoot,
      manifest,
      entries: new Map(manifest.files.map((entry) => [entry.path, entry])),
      allowed: ownerProofPaths,
      sourceStateBytes: boundedJson(bundleRoot, objectPath(sourceStateEntry)).bytes,
    });
  }
  const legacyRuns = manifest.files
    .filter((entry) => /^\.?(?:lode|head)\/sessions\/runs\/run-[0-9]+-[a-f0-9]{6}\/run\.json$/.test(entry.path))
    .map((entry) => ({ entry, run: boundedJson(bundleRoot, objectPath(entry)).value }))
    .filter((item) => item.run.sessionId == null);
  if (!sourceDefaultFormat)
    for (const { run } of legacyRuns)
      verifyBundledRunOwner({
        root: bundleRoot,
        manifest,
        entries: new Map(manifest.files.map((entry) => [entry.path, entry])),
        allowed: ownerProofPaths,
        runId: run.runId,
        run,
      });
  let defaultId = null;
  const defaultPath = storage.directory + "/sessions/current.json";
  const defaultFile = copiedProjectFile(targetRoot, defaultPath);
  if (fs.existsSync(defaultFile)) {
    try {
      defaultId = boundedJson(targetRoot, defaultPath).value.sessionId;
    } catch (error) {
      if (error.code) throw error;
    }
  }
  const sessionDirectory =
    defaultId === manifest.selectedSessionId ? storage.directory + "/sessions" : storage.directory + "/sessions/by-id/" + manifest.selectedSessionId;
  const selectedPath = sessionDirectory + "/current.json";
  const targetNamed = selectedPath !== defaultPath;
  const mapSelectedPath = (relative) =>
    relative === sourceSelectedPath
      ? selectedPath
      : relative.startsWith(sourceSessionDirectory + "/work-evidence/")
        ? sessionDirectory + relative.slice(sourceSessionDirectory.length)
        : relative;
  const stateEntry = {
    ...sourceStateEntry,
    sourcePath: sourceSelectedPath,
    path: selectedPath,
  };
  const archive = sessionDirectory + "/imports/" + bundleId;
  const active = [],
    historical = [];
  for (const entry of manifest.files) {
    const local = entry.path.slice(storage.directory.length + 1);
    const belongsToSession = entry.path === sourceSelectedPath || entry.path.startsWith(sourceSessionDirectory + "/work-evidence/");
    const immutableClosure =
      /^(?:lineage\/(?:whole-plans|execution-contracts|result-packets|review-decisions)\/|context\/capsules\/|sessions\/ledger\/|sessions\/runs\/|observations\/source-bundles\/)/.test(
        local,
      );
    if (belongsToSession || immutableClosure || ownerProofPaths.has(entry.path))
      active.push({ ...entry, sourcePath: entry.path, path: mapSelectedPath(entry.path) });
    else
      historical.push({
        ...entry,
        sourcePath: entry.path,
        path: archive + "/originals/" + entry.sha256 + ".bin",
      });
  }
  historical.push({
    ...sourceStateEntry,
    sourcePath: sourceSelectedPath,
    path: archive + "/originals/" + sourceStateEntry.sha256 + ".bin",
  });
  if (sourceDefaultFormat && targetNamed)
    for (const { entry } of legacyRuns)
      historical.push({
        ...entry,
        sourcePath: entry.path,
        path: archive + "/originals/" + entry.sha256 + ".bin",
      });
  const stateFile = copiedProjectFile(targetRoot, selectedPath);
  const stateAlreadyPresent = fs.existsSync(stateFile);
  const admissionPending = sessionDirectory + "/import-pending.json";
  const needsAdmission = !stateAlreadyPresent || fs.existsSync(copiedProjectFile(targetRoot, admissionPending));
  const pendingRelative = needsAdmission ? admissionPending : archive + "/pending.json";
  const pending = json({
    schemaVersion: 1,
    kind: "SelectedSessionImportIntent",
    projectId: storage.projectId,
    sessionId: manifest.selectedSessionId,
    bundleId,
    manifestSha256,
  });
  const assertTargetBasis = () => {
    assertProjectStorageUnchanged(storage);
    for (const entry of historical) {
      const sourceLocal = entry.sourcePath.slice(storage.directory.length + 1);
      if (/^(?:project-direction\/revisions|project-location)\//.test(sourceLocal)) {
        const original = copiedProjectFile(targetRoot, entry.sourcePath);
        if (fs.existsSync(original)) verifyCopiedProjectFile(targetRoot, { ...entry, path: entry.sourcePath });
      }
    }
    for (const entry of [...active, ...historical]) {
      const file = copiedProjectFile(targetRoot, entry.path);
      if (fs.existsSync(file)) verifyCopiedProjectFile(targetRoot, entry);
    }
  };
  assertTargetBasis();
  return withProjectMutation({ root: targetRoot, storage, scope: "selected-session-import" }, () => {
    assertTargetBasis();
    check(signal);
    exactCreate(targetRoot, pendingRelative, pending);
    for (const entry of [...active.filter((entry) => entry.path !== selectedPath), ...historical]) {
      const target = copiedProjectFile(targetRoot, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      copiedProjectFile(targetRoot, entry.path);
      copyOriginal(bundleRoot, targetRoot, entry, {
        signal,
        sourceRelative: objectPath(entry),
        targetRelative: entry.path,
      });
      onPublication?.("record", entry.path);
    }
    const originalManifest = fs.readFileSync(copiedProjectFile(bundleRoot, "manifest.json"));
    exactCreate(targetRoot, archive + "/bundle-manifest.json", originalManifest);
    const payload = {
      schemaVersion: 1,
      kind: "SelectedSessionImportReceipt",
      authorityPlane: "P3",
      projectId: storage.projectId,
      sessionId: manifest.selectedSessionId,
      bundleId,
      manifestSha256,
      stateOriginal: {
        sourcePath: sourceSelectedPath,
        path: selectedPath,
        sha256: stateEntry.sha256,
        bytes: stateEntry.bytes,
      },
      sourceDefaultFormat,
      activeOriginals: active.map((entry) => ({
        sourcePath: entry.sourcePath,
        storedPath: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      historicalOriginals: historical.map((entry) => ({
        sourcePath: entry.sourcePath,
        storedPath: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes,
      })),
      currentTargetCommon: "preserved-not-replaced",
      sourceCommon: "historical-only",
      grantsExecutionAuthorization: false,
      transfersNativeBinding: false,
      defaultSessionChanged: false,
    };
    const receiptDigest = sha(json(payload));
    exactCreate(
      targetRoot,
      archive + "/receipt.json",
      json({
        ...payload,
        receiptId: "session-import-" + receiptDigest.slice(0, 24),
        receiptDigest,
      }),
    );
    if (sourceDefaultFormat && targetNamed) {
      exactCreate(
        targetRoot,
        sessionDirectory + "/imports/owners/" + stateEntry.sha256 + ".json",
        json({
          schemaVersion: 1,
          kind: "ImportedDefaultSessionOwnerProof",
          authorityPlane: "P3",
          projectId: storage.projectId,
          sessionId: manifest.selectedSessionId,
          bundleId,
          receiptDigest,
          sourcePath: sourceSelectedPath,
          targetPath: selectedPath,
          originalSha256: stateEntry.sha256,
          grantsRecoveryDirection: false,
          grantsExecutionAuthorization: false,
        }),
      );
    }
    if (sourceDefaultFormat && targetNamed)
      for (const { entry, run } of legacyRuns)
        exactCreate(
          targetRoot,
          sessionDirectory + "/imports/run-owners/" + entry.sha256 + ".json",
          json({
            schemaVersion: 1,
            kind: "ImportedDefaultRunOwnerProof",
            authorityPlane: "P3",
            projectId: storage.projectId,
            sessionId: manifest.selectedSessionId,
            runId: run.runId,
            path: entry.path,
            originalSha256: entry.sha256,
            sourceStateSha256: stateEntry.sha256,
            grantsRecoveryDirection: false,
            grantsExecutionAuthorization: false,
          }),
        );
    assertTargetBasis();
    copyOriginal(bundleRoot, targetRoot, stateEntry, {
      signal,
      sourceRelative: objectPath(stateEntry),
      targetRelative: selectedPath,
    });
    onPublication?.("session", selectedPath);
    for (const entry of [...active, ...historical]) verifyCopiedProjectFile(targetRoot, entry);
    assertProjectStorageUnchanged(storage);
    check(signal);
    const pendingFile = copiedProjectFile(targetRoot, pendingRelative);
    if (!fs.readFileSync(pendingFile).equals(pending)) fail("PROJECT_BUNDLE_IMPORT_INTENT_CONFLICT");
    if (
      state.projectId == null &&
      targetNamed &&
      !verifyImportedDefaultSession({
        root: targetRoot,
        directory: storage.directory,
        project: { projectId: storage.projectId },
        sessionId: manifest.selectedSessionId,
        stateFile,
        stateBytes: fs.readFileSync(stateFile),
      })
    )
      fail("SESSION_IDENTITY_MISMATCH");
    fs.unlinkSync(pendingFile);
    return {
      status: needsAdmission ? "selected-session-imported" : "existing-project-originals-identical",
      bundleId,
      projectId: storage.projectId,
      selectedSessionId: manifest.selectedSessionId,
      targetRoot,
      sourceOriginalsReceipt: archive + "/receipt.json",
      sourceTransfer: {
        coverage: manifest.sourceTransfer || { status: "not-recorded-not-certified" },
        destinationOriginals: "verified-copied",
        exactDiff: "not-yet-queried",
      },
      currentTargetCommon: "preserved-not-replaced",
      sourceCommon: "historical-only",
      defaultSessionChanged: false,
      restoresExecutionPermission: false,
      nativeBindingTransferred: false,
    };
  });
}

export function readImportedSourceOriginal({ root, sessionId, bundleId, sourcePath, expectedDigest, offset = 0, maxBytes = 65536 } = {}) {
  const storage = resolveProjectStorage(root);
  if (
    !storage ||
    typeof sessionId !== "string" ||
    !/^session-[a-fA-F0-9-]{36}$/.test(sessionId) ||
    typeof bundleId !== "string" ||
    !/^project-bundle-[a-f0-9]{24}$/.test(bundleId) ||
    typeof expectedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedDigest)
  )
    fail("PROJECT_IMPORTED_ORIGINAL_SELECTOR_INVALID");
  let archive = storage.directory + "/sessions/by-id/" + sessionId + "/imports/" + bundleId;
  if (!fs.existsSync(copiedProjectFile(storage.projectRoot, archive + "/receipt.json"))) archive = storage.directory + "/sessions/imports/" + bundleId;
  const { value: receipt } = boundedJson(storage.projectRoot, archive + "/receipt.json");
  const { receiptId, receiptDigest, ...payload } = receipt;
  if (
    receipt.kind !== "SelectedSessionImportReceipt" ||
    receipt.authorityPlane !== "P3" ||
    receipt.projectId !== storage.projectId ||
    receipt.sessionId !== sessionId ||
    receipt.bundleId !== bundleId ||
    receiptDigest !== sha(json(payload)) ||
    receiptId !== "session-import-" + receiptDigest.slice(0, 24)
  )
    fail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
  const originalManifest = boundedJson(storage.projectRoot, archive + "/bundle-manifest.json");
  if (sha(originalManifest.bytes) !== receipt.manifestSha256 || bundleId !== "project-bundle-" + receipt.manifestSha256.slice(0, 24))
    fail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
  validatePortableManifestFormat(originalManifest.value);
  const mapping =
    receipt.historicalOriginals.find((entry) => entry.sourcePath === sourcePath && entry.sha256 === expectedDigest) ||
    receipt.activeOriginals?.find((entry) => entry.sourcePath === sourcePath && entry.sha256 === expectedDigest);
  if (!mapping || !originalManifest.value.files.some((entry) => entry.path === sourcePath && entry.sha256 === expectedDigest && entry.bytes === mapping.bytes))
    fail("PROJECT_IMPORTED_ORIGINAL_NOT_FOUND");
  const expectedPath = archive + "/originals/" + expectedDigest + ".bin";
  const activeMapping = receipt.activeOriginals?.some(
    (entry) => entry.sourcePath === sourcePath && entry.storedPath === mapping.storedPath && entry.sha256 === expectedDigest,
  );
  if (mapping.storedPath !== expectedPath && !activeMapping) fail("PROJECT_IMPORTED_ORIGINAL_RECEIPT_INVALID");
  const excerpt = readCopiedProjectExcerpt(
    storage.projectRoot,
    { path: mapping.storedPath, sha256: expectedDigest, bytes: mapping.bytes },
    { offset, maxBytes },
  );
  return {
    status: "verified-historical-source-original",
    authorityPlane: "P3",
    projectId: storage.projectId,
    sessionId,
    bundleId,
    sourcePath,
    storedPath: mapping.storedPath,
    rawSha256: expectedDigest,
    totalBytes: excerpt.totalBytes,
    offset,
    contentBase64: excerpt.bytes.toString("base64"),
    includedBytes: excerpt.bytes.length,
    partial: offset > 0 || excerpt.bytes.length < excerpt.totalBytes,
    currentTargetCanon: false,
    replacesCurrentCommon: false,
    grantsRecoveryAuthority: false,
    grantsExecutionAuthorization: false,
  };
}

function verifyBundledDefaultOwner({ root, manifest, entries, allowed, sourceStateBytes }) {
  const projectEntry = entries.get(manifest.directory + "/project.json");
  const project = boundedJson(root, objectPath(projectEntry)).value;
  const valid = verifyImportedDefaultSession({
    root,
    directory: manifest.directory,
    project,
    sessionId: manifest.selectedSessionId,
    stateFile: path.join(root, manifest.selectedSessionPath),
    stateBytes: sourceStateBytes,
    readOriginal(relative) {
      const entry = entries.get(relative);
      if (!entry) return null;
      const original = boundedJson(root, objectPath(entry));
      if (sha(original.bytes) !== entry.sha256 || original.bytes.length !== entry.bytes) fail("PROJECT_COPY_SOURCE_CHANGED");
      allowed.add(relative);
      return { bytes: original.bytes, document: original.value };
    },
  });
  if (!valid) fail("SESSION_IDENTITY_MISMATCH");
}

function verifyBundledRunOwner({ root, manifest, entries, allowed, runId, run }) {
  const project = boundedJson(root, objectPath(entries.get(manifest.directory + "/project.json"))).value;
  const relative = manifest.directory + "/sessions/runs/" + runId + "/run.json",
    entry = entries.get(relative);
  if (!entry) fail("PROJECT_BUNDLE_REFERENCE_MISSING");
  const valid = verifyImportedDefaultRun({
    root,
    directory: manifest.directory,
    project,
    sessionId: manifest.selectedSessionId,
    runFile: path.join(root, relative),
    runBytes: boundedJson(root, objectPath(entry)).bytes,
    run,
    readOriginal(relative) {
      const entry = entries.get(relative);
      if (!entry) return null;
      const original = boundedJson(root, objectPath(entry));
      if (sha(original.bytes) !== entry.sha256 || original.bytes.length !== entry.bytes) fail("PROJECT_COPY_SOURCE_CHANGED");
      allowed.add(relative);
      return { bytes: original.bytes, document: original.value };
    },
  });
  if (!valid) fail("RUN_SESSION_MISMATCH");
  return true;
}

// Hold the cooperative original lifetime from the first read to final publication.
export function exportProjectBundle(options = {}) {
  const root = options.root ?? ".";
  return withSnapshotReferences({ root, storage: resolveProjectStorage(root) }, () => exportProjectBundleUncoordinated(options));
}
