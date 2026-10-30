import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw Object.assign(new Error("Project location history does not preserve its original identity."), { code: "PROJECT_LOCATION_IDENTITY_MISMATCH" }); };
export const locationJournalRelative = "project-location/pending.json";

export function safeLocationFile(root, directory, relative) {
  if (![".lode", ".head"].includes(directory) || typeof relative !== "string" || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) fail();
  let file = root;
  for (const part of [directory, ...relative.split("/")]) {
    file = path.join(file, part);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail();
  }
  return file;
}

// Only metadata from exact local originals is compared. Historical root strings
// never cause a filesystem access, including Windows roots read on another OS.
export function verifyProjectLocation(root, directory, project) {
  const roots = [], seen = new Set(), invariant = value => {
    const { projectRoot, location, ...rest } = value; return JSON.stringify(rest);
  };
  const identity = invariant(project), prefix = directory === ".lode" ? "lode" : "head";
  let current = project;
  while (true) {
    if (current.schemaVersion !== 1 || current.projectId !== project.projectId || invariant(current) !== identity
      || typeof current.projectRoot !== "string" || !(path.posix.isAbsolute(current.projectRoot) || path.win32.isAbsolute(current.projectRoot))) fail();
    roots.push(current.projectRoot);
    if (current.location == null) {
      if (project.projectId !== `${prefix}-${hash(current.projectRoot).slice(0, 20)}`) fail();
      if (project.location && project.location.identityRoot !== current.projectRoot) fail();
      break;
    }
    const location = current.location;
    if (!location || typeof location !== "object" || Array.isArray(location)
      || Object.keys(location).sort().join(",") !== "identityRoot,previousProjectDigest"
      || !/^[a-f0-9]{64}$/.test(location.previousProjectDigest || "")
      || typeof location.identityRoot !== "string" || location.identityRoot !== project.location.identityRoot
      || seen.has(location.previousProjectDigest)) fail();
    seen.add(location.previousProjectDigest);
    const bytes = fs.readFileSync(safeLocationFile(root, directory, `project-location/history/${location.previousProjectDigest}.json`));
    if (hash(bytes) !== location.previousProjectDigest) fail();
    current = JSON.parse(bytes.toString("utf8"));
  }
  return { identityRoot: current.projectRoot, roots: [...new Set(roots)], digest: hash(JSON.stringify({ project, history: [...seen] })) };
}
