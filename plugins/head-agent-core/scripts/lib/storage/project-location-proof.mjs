import fs from "node:fs";
import path from "node:path";
import { PORTABLE_PROJECT_LOCATION_KIND, verifyPortableProjectLocation } from "./project-portable-proof.mjs";
import { COPIED_PROJECT_LOCATION_KIND, verifyCopiedProjectLocation } from "./project-copy-proof.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";

const fail = () => {
  throw Object.assign(new Error("Project location history does not preserve its original identity."), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" });
};
export const locationJournalRelative = "project-location/pending.json";

export function safeLocationFile(root, directory, relative) {
  if (
    ![".lode", ".head"].includes(directory) ||
    typeof relative !== "string" ||
    relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))
  )
    fail();
  let file = root;
  for (const part of [directory, ...relative.split("/")]) {
    file = path.join(file, part);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail();
  }
  return file;
}

// Only metadata from exact local originals is compared. Historical root strings
// never cause a filesystem access, including Windows roots read on another OS.
function inspectLocationChain(root, directory, project, readOriginal = null) {
  const roots = [],
    seen = new Set(),
    invariant = (value) => {
      const { projectRoot, location, ...rest } = value;
      return JSON.stringify(rest);
    };
  const identity = invariant(project),
    prefix = directory === ".lode" ? "lode" : "head";
  let current = project;
  while (true) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      current.schemaVersion !== 1 ||
      current.projectId !== project.projectId ||
      invariant(current) !== identity ||
      typeof current.projectRoot !== "string" ||
      !(path.posix.isAbsolute(current.projectRoot) || path.win32.isAbsolute(current.projectRoot))
    )
      fail();
    roots.push(current.projectRoot);
    if (current.location == null) {
      if (project.location && project.location.identityRoot !== current.projectRoot) fail();
      break;
    }
    const location = current.location;
    if (
      !location ||
      typeof location !== "object" ||
      Array.isArray(location) ||
      Object.keys(location).sort().join(",") !== "identityRoot,previousProjectDigest" ||
      typeof location.previousProjectDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(location.previousProjectDigest) ||
      typeof location.identityRoot !== "string" ||
      location.identityRoot !== project.location.identityRoot ||
      seen.has(location.previousProjectDigest)
    )
      fail();
    seen.add(location.previousProjectDigest);
    const relative = `${directory}/project-location/history/${location.previousProjectDigest}.json`;
    const bytes = readOriginal
      ? readOriginal(relative)
      : fs.readFileSync(safeLocationFile(root, directory, `project-location/history/${location.previousProjectDigest}.json`));
    if (hash(bytes) !== location.previousProjectDigest) fail();
    current = JSON.parse(bytes.toString("utf8"));
  }
  return {
    identityRoot: current.projectRoot,
    roots: [...new Set(roots)],
    digest: hash(JSON.stringify({ project, history: [...seen] })),
    originVerified: project.projectId === `${prefix}-${hash(current.projectRoot).slice(0, 20)}`,
  };
}

function verifyLocation(root, directory, project, readOriginal = null) {
  if (project?.location?.kind === PORTABLE_PROJECT_LOCATION_KIND)
    return verifyPortableProjectLocation(root, directory, project, (source) => verifyLocation(root, directory, source, readOriginal), readOriginal);
  if (project?.location?.kind === COPIED_PROJECT_LOCATION_KIND)
    return verifyCopiedProjectLocation(root, directory, project, (base, dir, original) => copyOrigin(base, dir, original, readOriginal), readOriginal);
  const { originVerified, ...proof } = inspectLocationChain(root, directory, project, readOriginal);
  if (!originVerified) fail();
  return proof;
}

// Copy preparation may distinguish an unproved initial origin only AFTER every
// declared predecessor and invariant passed. This observation grants no root
// alias, storage ownership, record admission or permission to publish a copy.
function copyOrigin(root, directory, project, readOriginal = null) {
  const proof = inspectLocationChain(root, directory, project, readOriginal);
  return {
    status: proof.originVerified ? "origin-verified" : "initial-origin-unverified",
    projectId: project.projectId,
    chainDigest: proof.digest,
    declaredHistoryVerified: true,
    grantsOwnership: false,
  };
}

export function verifyProjectLocation(root, directory, project) {
  return verifyLocation(root, directory, project);
}
export function inspectProjectCopyOrigin(root, directory, project) {
  return copyOrigin(root, directory, project);
}

// Original-data verification for a selected bundle. It registers no physical
// Core owner and grants no root alias or execution capability to its caller.
export function verifyProjectLocationOriginals({ directory, project, readOriginal }) {
  if (typeof readOriginal !== "function") fail();
  const proof = verifyLocation(null, directory, project, readOriginal);
  return { ...proof, grantsOwnership: false };
}
