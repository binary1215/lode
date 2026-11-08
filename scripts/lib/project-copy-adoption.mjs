import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact, atomicWriteArtifact } from "./core/fs-atomic.mjs";
import { copiedProjectFile, inspectCopiedProjectFiles, verifyCopiedProjectFile, validateCopiedManagedPaths } from "./project-copy-evidence.mjs";
import { inspectProjectCopyOrigin, verifyProjectLocation, locationJournalRelative } from "./project-location-proof.mjs";
import { inspectCopiedProjectCanon, verifyProjectMetadataOriginal } from "./project-copy-canon.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { COPIED_PROJECT_LOCATION_KIND } from "./project-copy-proof.mjs";
import { withLocalMutation } from "./project-mutation-lock.mjs";
import { sha256Hex as hash } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const read = (file) => fs.readFileSync(file);
const decode = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

function pendingCopy(input) {
  const file = copiedProjectFile(input.currentRoot, `${input.directory}/${locationJournalRelative}`);
  if (!fs.existsSync(file)) return null;
  const bytes = read(file),
    transaction = decode(bytes);
  return transaction.kind === "ProjectCopyPublication" ? { file, bytes, transaction } : null;
}

function publishCopy(input, transaction, pendingBytes, onPublication, inspectOnly = false) {
  const { currentRoot, directory, projectBytes, manifestBytes } = input;
  const canon = inspectCopiedProjectCanon({
    root: currentRoot,
    directory,
    project: input.project,
    selectedSession: input.selectedSession,
  });
  if (
    transaction.kind !== "ProjectCopyPublication" ||
    transaction.targetRoot !== currentRoot ||
    !["beforeProject", "afterProject", "beforeManifest", "afterManifest"].every((field) => typeof transaction[field] === "string") ||
    ![transaction.beforeProject, transaction.afterProject].some((value) => projectBytes.equals(Buffer.from(value))) ||
    ![transaction.beforeManifest, transaction.afterManifest].some((value) => manifestBytes.equals(Buffer.from(value)))
  )
    fail("PROJECT_COPY_PUBLICATION_CONFLICT");
  const before = decode(Buffer.from(transaction.beforeProject)),
    after = decode(Buffer.from(transaction.afterProject));
  const manifest = decode(Buffer.from(transaction.beforeManifest));
  const proof = verifyProjectLocation(currentRoot, directory, after);
  if (
    proof.copyAdmissionDigest !== transaction.admissionDigest ||
    proof.copyAdmission.sourceProjectDigest !== hash(Buffer.from(transaction.beforeProject)) ||
    proof.copyAdmission.sourceManifestDigest !== hash(Buffer.from(transaction.beforeManifest))
  )
    fail("PROJECT_COPY_PUBLICATION_CONFLICT");
  const expectedProject = json({
    ...before,
    projectRoot: currentRoot,
    location: {
      kind: COPIED_PROJECT_LOCATION_KIND,
      admissionDigest: transaction.admissionDigest,
      previousProjectDigest: hash(Buffer.from(transaction.beforeProject)),
    },
  });
  const expectedManifest = json({
    ...manifest,
    managed: manifest.managed.map((entry) => (entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(Buffer.from(expectedProject)) } : entry)),
  });
  if (transaction.afterProject !== expectedProject || transaction.afterManifest !== expectedManifest) fail("PROJECT_COPY_PUBLICATION_CONFLICT");
  const requiredOriginals = canon.originals.map((original) => {
    const entry = proof.copyAdmission.inventory.files.find((item) => item.path === original.path);
    if (!entry || entry.sha256 !== original.sha256 || entry.bytes !== original.bytes) fail("PROJECT_COPY_SOURCE_CHANGED");
    return entry;
  });
  const verifyRequiredOriginals = () => {
    for (const entry of requiredOriginals) verifyCopiedProjectFile(currentRoot, entry);
  };
  verifyRequiredOriginals();
  const result = {
    status: inspectOnly ? "verified-copy-publication-pending" : "verified-copy-adopted",
    projectId: before.projectId,
    projectRoot: currentRoot,
    previousRoot: before.projectRoot,
    origin: proof.origin,
    admissionDigest: transaction.admissionDigest,
    publicationPending: inspectOnly,
    evidenceValidation: "raw-byte-inventory-only-until-original-typed-read",
    nativeBindingTransferred: false,
    executionReplayAllowed: false,
  };
  if (inspectOnly) return result;
  const publish = (relative, actual, expected, stage) => {
    if (actual.equals(Buffer.from(expected))) return;
    atomicWriteArtifact(copiedProjectFile(currentRoot, relative), Buffer.from(expected), {
      beforePublish() {
        if (!read(copiedProjectFile(currentRoot, relative)).equals(actual)) fail("PROJECT_COPY_SOURCE_CHANGED");
      },
    });
    onPublication?.(stage);
  };
  publish(`${directory}/project.json`, projectBytes, transaction.afterProject, "copy-project");
  publish(`${directory}/generated/manifest.json`, manifestBytes, transaction.afterManifest, "copy-manifest");
  if (
    !read(copiedProjectFile(currentRoot, `${directory}/project.json`)).equals(Buffer.from(transaction.afterProject)) ||
    !read(copiedProjectFile(currentRoot, `${directory}/generated/manifest.json`)).equals(Buffer.from(transaction.afterManifest))
  )
    fail("PROJECT_COPY_PUBLICATION_CONFLICT");
  verifyRequiredOriginals();
  const pending = copiedProjectFile(currentRoot, `${directory}/${locationJournalRelative}`);
  if (!read(pending).equals(pendingBytes)) fail("PROJECT_COPY_PUBLICATION_CONFLICT");
  fs.unlinkSync(pending);
  return result;
}

export function inspectProjectCopyInput({ root, pluginRoot, runtimes, validateSelection = null } = {}) {
  const currentRoot = fs.realpathSync(path.resolve(root));
  let selected = null;
  try {
    selected = resolveProjectStorage(currentRoot);
  } catch (error) {
    if (!["PROJECT_IDENTITY_MISMATCH", "PROJECT_RELOCATION_PENDING"].includes(error.code)) throw error;
  }
  const directories = selected
    ? [selected.directory]
    : [".lode", ".head"].filter((dir) => fs.existsSync(copiedProjectFile(currentRoot, `${dir}/project.json`)));
  if (directories.length !== 1) fail(directories.length ? "PROJECT_STORAGE_CONFLICT" : "PROJECT_COPY_NOT_FOUND");
  const directory = directories[0],
    dialect = directory === ".lode" ? "lode" : "head";
  const projectBytes = read(copiedProjectFile(currentRoot, `${directory}/project.json`));
  const manifestBytes = read(copiedProjectFile(currentRoot, `${directory}/generated/manifest.json`));
  const project = decode(projectBytes),
    manifest = decode(manifestBytes);
  verifyProjectMetadataOriginal(project, directory);
  const packageRoot = fs.realpathSync(path.resolve(pluginRoot));
  const metadata = decode(read(path.join(packageRoot, "package.json")));
  if (typeof metadata.version !== "string" || !metadata.version) fail("PROJECT_COPY_PACKAGE_INVALID");
  if (runtimes != null) {
    if (!Array.isArray(runtimes) || !runtimes.every((value) => typeof value === "string")) fail("UNSUPPORTED_RUNTIME");
    const selected = [
      ...new Set((runtimes.length ? runtimes : ["claude", "codex", "opencode"]).map((value) => value.trim().toLowerCase()).filter(Boolean)),
    ].sort();
    if (JSON.stringify(selected) !== JSON.stringify(project.runtimes)) fail("PROJECT_RUNTIME_MISMATCH");
  }
  validateCopiedManagedPaths({ root: currentRoot, directory, manifest });
  const selectedSession = validateSelection?.({
    root: currentRoot,
    storage: { dialect, directory },
    project,
  });
  return {
    currentRoot,
    directory,
    dialect,
    project,
    manifest,
    projectBytes,
    manifestBytes,
    selectedSession,
  };
}

// The explicit copy choice authorizes metadata relocation only. P1/P2 originals
// remain byte-exact; this evidence cannot create a review or execution grant.
export function adoptVerifiedProjectCopy(options = {}) {
  const initial = inspectProjectCopyInput(options);
  const pending = pendingCopy(initial);
  if (pending) {
    if (options.inspectOnly) return publishCopy(initial, pending.transaction, pending.bytes, null, true);
    return withLocalMutation(
      {
        directory: copiedProjectFile(initial.currentRoot, `${initial.directory}/.operations/project-relocation.lock`),
      },
      () => {
        const current = inspectProjectCopyInput(options),
          observed = pendingCopy(current);
        if (!observed || !observed.bytes.equals(pending.bytes)) fail("PROJECT_COPY_PUBLICATION_CONFLICT");
        return publishCopy(current, observed.transaction, observed.bytes, options.onPublication);
      },
    );
  }
  if ([COPIED_PROJECT_LOCATION_KIND, "portable-project-copy"].includes(initial.project.location?.kind)) return null;
  const origin = inspectProjectCopyOrigin(initial.currentRoot, initial.directory, initial.project);
  if (origin.status === "origin-verified") return null;
  inspectCopiedProjectCanon({
    root: initial.currentRoot,
    directory: initial.directory,
    project: initial.project,
    selectedSession: initial.selectedSession,
  });
  const pendingFile = copiedProjectFile(initial.currentRoot, `${initial.directory}/${locationJournalRelative}`);
  if (fs.existsSync(pendingFile)) fail("PROJECT_RELOCATION_PENDING");
  if (options.inspectOnly)
    return {
      status: "verified-copy-available",
      projectId: initial.project.projectId,
      projectRoot: initial.currentRoot,
      previousRoot: initial.project.projectRoot,
      origin: origin.status,
      publicationPending: false,
      persisted: false,
    };
  return withLocalMutation(
    {
      directory: copiedProjectFile(initial.currentRoot, `${initial.directory}/.operations/project-relocation.lock`),
    },
    () => {
      const input = inspectProjectCopyInput(options);
      if (!input.projectBytes.equals(initial.projectBytes) || !input.manifestBytes.equals(initial.manifestBytes)) fail("PROJECT_COPY_SOURCE_CHANGED");
      const { currentRoot, directory, project, manifest, projectBytes, manifestBytes } = input;
      if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.managed)) fail("PROJECT_REPAIR_MANIFEST_INVALID");
      const managed = new Set();
      for (const entry of manifest.managed) {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          managed.has(entry.path) ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          (!entry.path.startsWith(`${directory}/`) && !["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path))
        )
          fail("PROJECT_REPAIR_MANIFEST_INVALID");
        managed.add(entry.path);
        if (hash(read(copiedProjectFile(currentRoot, entry.path))) !== entry.sha256) fail("PROJECT_NOT_READY");
      }
      if (!managed.has(`${directory}/project.json`)) fail("PROJECT_REPAIR_MANIFEST_INVALID");
      inspectCopiedProjectCanon({
        root: currentRoot,
        directory,
        project,
        selectedSession: input.selectedSession,
      });
      const inventory = inspectCopiedProjectFiles({ root: currentRoot, directory });
      const admission = {
        schemaVersion: 1,
        kind: "VerifiedProjectCopyAdmission",
        projectId: project.projectId,
        directory,
        acceptedRoot: currentRoot,
        origin: "initial-origin-unverified",
        sourceProjectDigest: hash(projectBytes),
        sourceManifestDigest: hash(manifestBytes),
        inventory,
      };
      const admissionBytes = Buffer.from(json(admission)),
        admissionDigest = hash(admissionBytes);
      const afterProject = Buffer.from(
        json({
          ...project,
          projectRoot: currentRoot,
          location: {
            kind: COPIED_PROJECT_LOCATION_KIND,
            admissionDigest,
            previousProjectDigest: hash(projectBytes),
          },
        }),
      );
      const afterManifest = Buffer.from(
        json({
          ...manifest,
          managed: manifest.managed.map((entry) => (entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(afterProject) } : entry)),
        }),
      );
      const createExact = (relative, bytes) => {
        const file = copiedProjectFile(currentRoot, relative);
        if (fs.existsSync(file)) {
          if (!read(file).equals(bytes)) fail("PROJECT_COPY_IMMUTABLE_CONFLICT");
        } else atomicCreateArtifact(file, bytes);
      };
      createExact(`${directory}/project-location/history/${hash(projectBytes)}.json`, projectBytes);
      createExact(`${directory}/project-location/copy-originals/${hash(manifestBytes)}.json`, manifestBytes);
      createExact(`${directory}/project-location/copies/${admissionDigest}.json`, admissionBytes);
      const transaction = {
        kind: "ProjectCopyPublication",
        targetRoot: currentRoot,
        admissionDigest,
        beforeProject: projectBytes.toString("utf8"),
        afterProject: afterProject.toString("utf8"),
        beforeManifest: manifestBytes.toString("utf8"),
        afterManifest: afterManifest.toString("utf8"),
      };
      createExact(`${directory}/${locationJournalRelative}`, Buffer.from(json(transaction)));
      for (const entry of inventory.files) verifyCopiedProjectFile(currentRoot, entry);
      return publishCopy(input, transaction, Buffer.from(json(transaction)), options.onPublication);
    },
  );
}
