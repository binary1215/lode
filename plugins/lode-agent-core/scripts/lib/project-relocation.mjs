import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { withLocalMutation } from "./project-mutation-lock.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { safeLocationFile, verifyProjectLocation, locationJournalRelative } from "./project-location-proof.mjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message, code = "PROJECT_RELOCATION_CONFLICT") => { throw Object.assign(new Error(message), { code }); };
const read = file => fs.readFileSync(file, "utf8");

function validateManifest(root, directory, projectBytes, manifestBytes) {
  const manifest = JSON.parse(manifestBytes), paths = new Set();
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
      if (entry.path.includes("/") || entry.path.includes("\\") || !["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path)) fail("Managed manifest path is invalid.");
      file = path.join(root, entry.path); if (fs.lstatSync(file).isSymbolicLink()) fail("Managed integration is a symlink.");
    }
    const bytes = entry.path === `${directory}/project.json` ? projectBytes : fs.readFileSync(file);
    if (hash(bytes) !== entry.sha256) fail(`Managed file drift prevents relocation: ${entry.path}`, "PROJECT_NOT_READY");
  }
  if (!paths.has(`${directory}/project.json`)) fail("Managed manifest does not own Project metadata.");
  return manifest;
}

// An explicit initialize/resume may adopt only the local copied owner. No old
// directory is probed, no Session history is rewritten, and no effect is replayed.
export function resumeProjectLocation({ root, pluginRoot, runtimes, validateSelection = null, onPublication = null, inspectOnly = false } = {}) {
  const currentRoot = fs.realpathSync(path.resolve(root || "."));
  try { if (resolveProjectStorage(currentRoot)) return null; }
  catch (error) { if (!["PROJECT_RELOCATION_PENDING", "PROJECT_IDENTITY_MISMATCH"].includes(error.code)) throw error; }
  const candidates = [".lode", ".head"].filter(directory => fs.existsSync(path.join(currentRoot, directory, "project.json")));
  if (!candidates.length) return null;
  const entries = candidates.map(directory => ({ directory,
    project: JSON.parse(read(safeLocationFile(currentRoot, directory, "project.json"))),
    pending: fs.existsSync(safeLocationFile(currentRoot, directory, locationJournalRelative)) }));
  const needed = entries.filter(entry => entry.pending || entry.project.projectRoot !== currentRoot);
  if (!needed.length) return null;
  if (!entries.some(entry => entry.pending) && entries.some(entry => entry.project.projectRoot === currentRoot)) return null;
  if (entries.length !== 1) fail("Conflicting local Project owners prevent folder relocation.", "PROJECT_STORAGE_CONFLICT");
  const { directory } = needed[0], storage = { dialect: directory === ".lode" ? "lode" : "head", directory };
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
  const operation = publish => {
    const projectFile = safeLocationFile(currentRoot, directory, "project.json");
    const manifestFile = safeLocationFile(currentRoot, directory, "generated/manifest.json");
    const journalFile = safeLocationFile(currentRoot, directory, locationJournalRelative);
    const currentProjectBytes = read(projectFile), currentManifestBytes = read(manifestFile);
    let transaction;
    if (fs.existsSync(journalFile)) {
      transaction = JSON.parse(read(journalFile));
      if (transaction.kind !== "ProjectLocationPublication" || transaction.targetRoot !== currentRoot
        || !["beforeProject", "afterProject", "beforeManifest", "afterManifest"].every(field => typeof transaction[field] === "string")
        || ![transaction.beforeProject, transaction.afterProject].includes(currentProjectBytes)
        || ![transaction.beforeManifest, transaction.afterManifest].includes(currentManifestBytes)) fail("Pending relocation diverged; no file was overwritten.");
    } else {
      const project = JSON.parse(currentProjectBytes);
      if (project.projectRoot === currentRoot) return null;
      const proof = verifyProjectLocation(currentRoot, directory, project);
      const nextProject = { ...project, projectRoot: currentRoot, location: { identityRoot: proof.identityRoot, previousProjectDigest: hash(currentProjectBytes) } };
      const manifest = validateManifest(currentRoot, directory, currentProjectBytes, currentManifestBytes);
      const nextBytes = json(nextProject);
      transaction = { kind: "ProjectLocationPublication", targetRoot: currentRoot,
        beforeProject: currentProjectBytes, afterProject: nextBytes, beforeManifest: currentManifestBytes,
        afterManifest: json({ ...manifest, managed: manifest.managed.map(entry => entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(nextBytes) } : entry) }) };
    }
    const original = JSON.parse(transaction.beforeProject), next = JSON.parse(transaction.afterProject);
    const role = directory === ".lode" ? "lode" : "head";
    if (typeof original.authority?.[role] !== "string" || typeof original.authority?.user !== "string"
      || typeof original.createdAt !== "string" || !Number.isFinite(Date.parse(original.createdAt))
      || !Array.isArray(original.runtimes) || !original.runtimes.length || !original.runtimes.every(value => ["codex", "claude", "opencode"].includes(value))
      || !original.integrations || typeof original.integrations !== "object" || Array.isArray(original.integrations)) fail("Copied Project metadata is malformed.", "INVALID_CANON");
    const proof = verifyProjectLocation(currentRoot, directory, original);
    const expected = { ...original, projectRoot: currentRoot, location: { identityRoot: proof.identityRoot, previousProjectDigest: hash(transaction.beforeProject) } };
    if (JSON.stringify(next) !== JSON.stringify(expected)) fail("Pending relocation changes more than location metadata.");
    const manifest = validateManifest(currentRoot, directory, transaction.beforeProject, transaction.beforeManifest);
    if (transaction.afterManifest !== json({ ...manifest, managed: manifest.managed.map(entry => entry.path === `${directory}/project.json` ? { ...entry, sha256: hash(transaction.afterProject) } : entry) })) fail("Pending manifest is not the exact location transition.");
    if (runtimes != null) {
      if (!Array.isArray(runtimes) || runtimes.some(value => typeof value !== "string")) fail("Runtime set is invalid.", "UNSUPPORTED_RUNTIME");
      const selected = [...new Set((runtimes.length ? runtimes : ["claude", "codex", "opencode"]).map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
      if (JSON.stringify(selected) !== JSON.stringify(original.runtimes)) fail("Requested runtimes do not match this Project.", "PROJECT_RUNTIME_MISMATCH");
    }
    // The journal has authenticated BOTH acceptable on-disk Project versions.
    // Session preflight compares against the actual version at this boundary,
    // not necessarily the historical before version after a partial commit.
    validateSelection?.({ root: currentRoot, storage, project: JSON.parse(currentProjectBytes) });
    if (!publish) return { status: "relocation-needed", projectId: original.projectId, projectRoot: currentRoot,
      previousRoot: original.projectRoot, publicationPending: fs.existsSync(journalFile) };
    const historyFile = safeLocationFile(currentRoot, directory, `project-location/history/${hash(transaction.beforeProject)}.json`);
    if (fs.existsSync(historyFile)) { if (read(historyFile) !== transaction.beforeProject) fail("Location original digest differs."); }
    else atomicCreateArtifact(historyFile, transaction.beforeProject);
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
    return { status: "relocated", projectId: next.projectId, previousRoot: original.projectRoot, projectRoot: currentRoot,
      historicalProjectDigest: hash(transaction.beforeProject), executionReplayAllowed: false, nativeBindingTransferred: false };
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
