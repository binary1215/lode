import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact, atomicWriteArtifact } from "../core/fs-atomic.mjs";
import { withLocalMutation } from "./project-mutation-lock.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { safeLocationFile, verifyProjectLocation, locationJournalRelative } from "./project-location-proof.mjs";
import { COPIED_PROJECT_LOCATION_KIND } from "./project-copy-proof.mjs";
import { adoptVerifiedProjectCopy, inspectProjectCopyInput } from "./project-copy-adoption.mjs";
import { validateCopiedManagedPaths } from "./project-copy-evidence.mjs";
import { inspectProjectCopyOrigin } from "./project-location-proof.mjs";
import { inspectManagedByteRepairs, repairManagedProjectBytes } from "./project-record-byte-repair.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failWith } from "../core/errors.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = failWith("PROJECT_RELOCATION_CONFLICT");
const read = (file) => fs.readFileSync(file, "utf8");
const nextLocation = (proof, previousProjectDigest) =>
  proof.copyAdmissionDigest
    ? { kind: proof.locationKind ?? COPIED_PROJECT_LOCATION_KIND, admissionDigest: proof.copyAdmissionDigest, previousProjectDigest }
    : { identityRoot: proof.identityRoot, previousProjectDigest };

function validateManifest(root, directory, projectBytes, manifestBytes) {
  const manifest = JSON.parse(manifestBytes),
    paths = new Set();
  validateCopiedManagedPaths({ root, directory, manifest });
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.managed)) fail("Managed manifest is invalid.");
  for (const entry of manifest.managed) {
    if (typeof entry.path !== "string" || paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) fail("Managed manifest has invalid entries.");
    paths.add(entry.path);
    const relative = entry.path.startsWith(`${directory}/`) ? entry.path.slice(directory.length + 1) : null;
    // Root-level integration files use the same local path confinement; a
    // manifest cannot redirect migration to another folder or a symlink.
    let file;
    if (relative) file = safeLocationFile(root, directory, relative);
    else {
      if (entry.path.includes("/") || entry.path.includes("\\") || !["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path))
        fail("Managed manifest path is invalid.");
      file = path.join(root, entry.path);
      if (fs.lstatSync(file).isSymbolicLink()) fail("Managed integration is a symlink.");
    }
    const bytes = entry.path === `${directory}/project.json` ? projectBytes : fs.readFileSync(file);
    if (hash(bytes) !== entry.sha256) fail(`Managed file drift prevents relocation: ${entry.path}`, "PROJECT_NOT_READY");
  }
  if (!paths.has(`${directory}/project.json`)) fail("Managed manifest does not own Project metadata.");
  return manifest;
}

// Exact recorded bytes can be restored during explicit resume, after the same
// pure owner/Session/runtime checks. Missing and edited files remain untouched.
export function repairProjectBytesForResume(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || "."));
  const local = [".lode", ".head"].filter((directory) => fs.existsSync(path.join(root, directory, "project.json")));
  if (!local.length) return null;
  // A no-op byte inspection does not consume a logical Session. Validate it
  // only when an actual repair depends on that owner.
  const input = inspectProjectCopyInput({ ...options, root, validateSelection: null });
  if (fs.existsSync(safeLocationFile(root, input.directory, locationJournalRelative))) return null;
  if ([COPIED_PROJECT_LOCATION_KIND, "portable-project-copy"].includes(input.project.location?.kind))
    verifyProjectLocation(root, input.directory, input.project);
  else inspectProjectCopyOrigin(root, input.directory, input.project);
  const plan = inspectManagedByteRepairs({ root, directory: input.directory, manifest: input.manifest });
  if (!plan.repairs.length) return null;
  options.validateSelection?.({ root, storage: { dialect: input.dialect, directory: input.directory }, project: input.project });
  return repairManagedProjectBytes({ root, directory: input.directory, manifest: input.manifest });
}

// Explicit resume may reach the recorded-byte repair after a read-only
// preflight; status uses the same preflight to name resume as the next step.
// Relocation publication still requires exact on-disk digests. Do not treat
// arbitrary drift or a pending journal as repair.
export function inspectProjectResumeLocation(options = {}) {
  try {
    return resumeProjectLocation({ ...options, inspectOnly: true });
  } catch (error) {
    if (error.code !== "PROJECT_NOT_READY") throw error;
    const input = inspectProjectCopyInput(options);
    if (fs.existsSync(safeLocationFile(input.currentRoot, input.directory, locationJournalRelative))) throw error;
    verifyProjectLocation(input.currentRoot, input.directory, input.project);
    const plan = inspectManagedByteRepairs({ root: input.currentRoot, directory: input.directory, manifest: input.manifest });
    // Name the files that block the repair, not the first file that differs.
    if (plan.unresolved.length)
      fail(
        `Managed file drift prevents relocation: ${plan.unresolved.map((item) => `${item.path} (${item.reasonCode})`).join(", ")}. ` +
          "Resume restores only files whose line endings changed; no file has been changed.",
        "PROJECT_NOT_READY",
      );
    if (!plan.repairs.length) throw error;
    return {
      status: "relocation-byte-repair-needed",
      projectId: input.project.projectId,
      projectRoot: input.currentRoot,
      previousRoot: input.project.projectRoot,
      byteRepair: { status: "available-on-resume", paths: plan.repairs.map((item) => item.path), transformation: "exact-recorded-digest-line-ending-repair" },
      persisted: false,
    };
  }
}

// An explicit initialize/resume may adopt only the local copied owner. No old
// directory is probed, no Session history is rewritten, and no effect is replayed.
export function resumeProjectLocation({
  root,
  pluginRoot,
  runtimes,
  validateSelection = null,
  onPublication = null,
  inspectOnly = false,
  copiedProject = null,
} = {}) {
  const currentRoot = fs.realpathSync(path.resolve(root || "."));
  if (copiedProject !== null && copiedProject !== "verified-copy")
    fail("copiedProject must be verified-copy when explicitly adopting an unproved local copy.", "PROJECT_COPY_CHOICE_INVALID");
  const local = [".lode", ".head"].filter((directory) => fs.existsSync(path.join(currentRoot, directory, "project.json")));
  const copyPending =
    local.length === 1 &&
    fs.existsSync(safeLocationFile(currentRoot, local[0], locationJournalRelative)) &&
    JSON.parse(read(safeLocationFile(currentRoot, local[0], locationJournalRelative))).kind === "ProjectCopyPublication";
  if (copiedProject || copyPending) {
    const adopted = adoptVerifiedProjectCopy({ root: currentRoot, pluginRoot, runtimes, validateSelection, onPublication, inspectOnly });
    if (adopted) return adopted;
  }
  try {
    if (resolveProjectStorage(currentRoot)) return null;
  } catch (error) {
    if (!["PROJECT_RELOCATION_PENDING", "PROJECT_IDENTITY_MISMATCH"].includes(error.code)) throw error;
  }
  const candidates = [".lode", ".head"].filter((directory) => fs.existsSync(path.join(currentRoot, directory, "project.json")));
  if (!candidates.length) return null;
  const entries = candidates.map((directory) => ({
    directory,
    project: JSON.parse(read(safeLocationFile(currentRoot, directory, "project.json"))),
    pending: fs.existsSync(safeLocationFile(currentRoot, directory, locationJournalRelative)),
  }));
  const needed = entries.filter((entry) => entry.pending || entry.project.projectRoot !== currentRoot);
  if (!needed.length) return null;
  if (!entries.some((entry) => entry.pending) && entries.some((entry) => entry.project.projectRoot === currentRoot)) return null;
  if (entries.length !== 1) fail("Conflicting local Project owners prevent folder relocation.", "PROJECT_STORAGE_CONFLICT");
  const { directory } = needed[0],
    storage = { dialect: directory === ".lode" ? "lode" : "head", directory };
  // Pure input preflight precedes even journal recovery. Invalid package/runtime
  // or Session inputs cannot relocate a Project as a side effect of refusal.
  const packageRoot = fs.realpathSync(path.resolve(pluginRoot));
  const metadata = JSON.parse(read(path.join(packageRoot, "package.json")));
  if (typeof metadata.version !== "string" || !metadata.version) fail("Plugin package version is missing.");
  const codexManifest = path.join(packageRoot, ".codex-plugin/plugin.json");
  if (fs.existsSync(codexManifest)) {
    const value = JSON.parse(read(codexManifest));
    if (typeof value.version !== "string" || !value.version.trim()) fail("Plugin manifest version is missing.");
  }
  const operation = (publish) => {
    const projectFile = safeLocationFile(currentRoot, directory, "project.json");
    const manifestFile = safeLocationFile(currentRoot, directory, "generated/manifest.json");
    const journalFile = safeLocationFile(currentRoot, directory, locationJournalRelative);
    const currentProjectBytes = read(projectFile),
      currentManifestBytes = read(manifestFile);
    let transaction;
    if (fs.existsSync(journalFile)) {
      transaction = JSON.parse(read(journalFile));
      if (
        transaction.kind !== "ProjectLocationPublication" ||
        transaction.targetRoot !== currentRoot ||
        !["beforeProject", "afterProject", "beforeManifest", "afterManifest"].every((field) => typeof transaction[field] === "string") ||
        ![transaction.beforeProject, transaction.afterProject].includes(currentProjectBytes) ||
        ![transaction.beforeManifest, transaction.afterManifest].includes(currentManifestBytes)
      )
        fail("Pending relocation diverged; no file was overwritten.");
    } else {
      const project = JSON.parse(currentProjectBytes);
      if (project.projectRoot === currentRoot) return null;
      const origin = [COPIED_PROJECT_LOCATION_KIND, "portable-project-copy"].includes(project.location?.kind)
        ? null
        : inspectProjectCopyOrigin(currentRoot, directory, project);
      if (origin?.status === "initial-origin-unverified") {
        if (inspectOnly)
          return {
            status: "verified-copy-available",
            projectId: project.projectId,
            projectRoot: currentRoot,
            previousRoot: project.projectRoot,
            origin: origin.status,
            persisted: false,
            requiredChoice: "verified-copy",
          };
        fail(
          "The initial origin cannot be proved. Explicitly choose copiedProject=verified-copy to retain it as an origin-unverified copy; damaged declared history cannot be adopted.",
          "PROJECT_COPY_CHOICE_REQUIRED",
        );
      }
      const proof = verifyProjectLocation(currentRoot, directory, project);
      const nextProject = { ...project, projectRoot: currentRoot, location: nextLocation(proof, hash(currentProjectBytes)) };
      const manifest = validateManifest(currentRoot, directory, currentProjectBytes, currentManifestBytes);
      const nextBytes = json(nextProject);
      transaction = {
        kind: "ProjectLocationPublication",
        targetRoot: currentRoot,
        beforeProject: currentProjectBytes,
        afterProject: nextBytes,
        beforeManifest: currentManifestBytes,
        afterManifest: json({
          ...manifest,
          managed: manifest.managed.map((entry) => (entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(nextBytes) } : entry)),
        }),
      };
    }
    const original = JSON.parse(transaction.beforeProject),
      next = JSON.parse(transaction.afterProject);
    const role = directory === ".lode" ? "lode" : "head";
    if (
      typeof original.authority?.[role] !== "string" ||
      typeof original.authority?.user !== "string" ||
      typeof original.createdAt !== "string" ||
      !Number.isFinite(Date.parse(original.createdAt)) ||
      !Array.isArray(original.runtimes) ||
      !original.runtimes.length ||
      !original.runtimes.every((value) => ["codex", "claude", "opencode"].includes(value)) ||
      !original.integrations ||
      typeof original.integrations !== "object" ||
      Array.isArray(original.integrations)
    )
      fail("Copied Project metadata is malformed.", "INVALID_CANON");
    const proof = verifyProjectLocation(currentRoot, directory, original);
    const expected = { ...original, projectRoot: currentRoot, location: nextLocation(proof, hash(transaction.beforeProject)) };
    if (JSON.stringify(next) !== JSON.stringify(expected)) fail("Pending relocation changes more than location metadata.");
    const manifest = validateManifest(currentRoot, directory, transaction.beforeProject, transaction.beforeManifest);
    if (
      transaction.afterManifest !==
      json({
        ...manifest,
        managed: manifest.managed.map((entry) => (entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(transaction.afterProject) } : entry)),
      })
    )
      fail("Pending manifest is not the exact location transition.");
    if (runtimes != null) {
      if (!Array.isArray(runtimes) || runtimes.some((value) => typeof value !== "string")) fail("Runtime set is invalid.", "UNSUPPORTED_RUNTIME");
      const selected = [
        ...new Set((runtimes.length ? runtimes : ["claude", "codex", "opencode"]).map((value) => value.trim().toLowerCase()).filter(Boolean)),
      ].sort();
      if (JSON.stringify(selected) !== JSON.stringify(original.runtimes)) fail("Requested runtimes do not match this Project.", "PROJECT_RUNTIME_MISMATCH");
    }
    // The journal has authenticated BOTH acceptable on-disk Project versions.
    // Session preflight compares against the actual version at this boundary,
    // not necessarily the historical before version after a partial commit.
    validateSelection?.({ root: currentRoot, storage, project: JSON.parse(currentProjectBytes) });
    if (!publish)
      return {
        status: "relocation-needed",
        projectId: original.projectId,
        projectRoot: currentRoot,
        previousRoot: original.projectRoot,
        publicationPending: fs.existsSync(journalFile),
      };
    const historyFile = safeLocationFile(currentRoot, directory, `project-location/history/${hash(transaction.beforeProject)}.json`);
    if (fs.existsSync(historyFile)) {
      if (read(historyFile) !== transaction.beforeProject) fail("Location original digest differs.");
    } else atomicCreateArtifact(historyFile, transaction.beforeProject);
    if (!fs.existsSync(journalFile)) atomicCreateArtifact(journalFile, json(transaction));
    else if (read(journalFile) !== json(transaction)) fail("Pending location publication changed.");
    // Reader selection rejects pending publication, even when Project itself
    // has already moved. A retry rolls forward only these exact two byte pairs.
    if (read(projectFile) !== currentProjectBytes || read(manifestFile) !== currentManifestBytes) fail("Location publication basis changed.");
    atomicWriteArtifact(projectFile, transaction.afterProject);
    onPublication?.("project");
    atomicWriteArtifact(manifestFile, transaction.afterManifest);
    onPublication?.("manifest");
    if (read(journalFile) !== json(transaction)) fail("Pending location publication changed.");
    fs.unlinkSync(journalFile);
    return {
      status: "relocated",
      projectId: next.projectId,
      previousRoot: original.projectRoot,
      projectRoot: currentRoot,
      historicalProjectDigest: hash(transaction.beforeProject),
      executionReplayAllowed: false,
      nativeBindingTransferred: false,
    };
  };
  const preparation = operation(false);
  if (inspectOnly) return preparation;
  // An exact moved/pending location cannot be selected as an ordinary Project
  // (or collected) yet. The preflight above authenticates the owner/journal and
  // both permitted byte pairs; recheck them under the existing local lock.
  // Do not introduce a caller-controlled snapshot-lifetime bypass for normal
  // Project mutations merely because they supply a relocation scope string.
  return withLocalMutation({ directory: safeLocationFile(currentRoot, directory, ".operations/project-relocation.lock") }, () => operation(true));
}
