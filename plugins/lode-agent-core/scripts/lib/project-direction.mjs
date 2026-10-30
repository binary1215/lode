import { formatForVerifiedOwner, resolveProjectStorage } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeSessionPath } from "./session-paths.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "./artifact-storage.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { noteProjectGraphChange } from "./discovery-index.mjs";

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`Project direction is unreadable: ${error.message}`, "INVALID_PROJECT_DIRECTION"); } };

function directionStorage(root) {
  return resolveProjectStorage(root, { readLegacyProject() {
    const project = read(safeSessionPath(root, ".head", "project.json"));
    if (project.projectRoot !== fs.realpathSync(path.resolve(root))) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
    return project;
  } });
}

function verify(record, project) {
  const keys = ["schemaVersion", "kind", "authorityPlane", "authorityBoundary", "projectId", "previousDirectionId", "input", "source", "grantsExecutionAuthorization", "directionId", "directionHash"];
  if (!record || Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))
    || record.schemaVersion !== 1 || record.kind !== "ProjectDirection" || record.authorityPlane !== "P2"
    || record.source !== "explicit-current-user-direction-conveyed-by-caller" || record.grantsExecutionAuthorization !== false
    || record.previousDirectionId !== null && !/^direction-[a-f0-9]{24}$/.test(record.previousDirectionId || "")
    || hash(normalized(record.input)) !== hash(record.input)) fail("Project direction shape or authority is invalid.", "INVALID_PROJECT_DIRECTION");
  verifyArtifactAuthorityBoundary("ProjectDirection", record.authorityBoundary);
  const { directionId, directionHash, ...payload } = record;
  if (record.projectId !== project.projectId || directionHash !== hash(payload) || directionId !== `direction-${directionHash.slice(0, 24)}`) fail("Project direction identity/digest differs.", "PROJECT_DIRECTION_INTEGRITY_FAILURE");
  return record;
}

function directionFileStat(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail("Session path traverses a symlink.", "SESSION_PATH_ESCAPE");
    return stat;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function hasUnlinkedDirectionTrace(root, storage) {
  // Empty directories are not saved direction. Only recognizable originals or
  // our exact atomic publication stages establish an interrupted/lost linkage.
  // Never select a revision by its name, age, contents, or candidate count.
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const pointerStage = new RegExp(`^\\.current\\.json\\.${uuid}\\.tmp$`);
  const revisionStage = new RegExp(`^\\.direction-[a-f0-9]{24}\\.json\\.${uuid}\\.tmp$`);
  const traceIn = (directory, matches) => {
    const stat = directionFileStat(directory);
    if (!stat) return false;
    if (!stat.isDirectory()) fail("Project direction store is not a directory.", "INVALID_PROJECT_DIRECTION");
    let found = false;
    for (const name of fs.readdirSync(directory)) {
      if (!matches(name)) continue;
      const trace = directionFileStat(safeSessionPath(root, path.relative(fs.realpathSync(path.resolve(root)), path.join(directory, name))));
      if (trace && !trace.isFile()) fail("Project direction trace is not a file.", "INVALID_PROJECT_DIRECTION");
      if (trace) found = true;
    }
    return found;
  };
  const directory = safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction");
  const pointerTrace = traceIn(directory, (name) => pointerStage.test(name));
  const revisionTrace = traceIn(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "revisions"),
    (name) => /^direction-.*\.json$/.test(name) || revisionStage.test(name));
  return pointerTrace || revisionTrace;
}

export function readProjectDirection({ root = ".", storage } = {}) {
  storage ??= directionStorage(root);
  const project = read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json"));
  if (project.projectRoot !== fs.realpathSync(path.resolve(root))) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  const file = safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "current.json");
  if (!directionFileStat(file)) {
    if (hasUnlinkedDirectionTrace(root, storage)) fail("Current Project direction linkage is unavailable; retained originals or publication stages are not an approved empty direction.", "PROJECT_DIRECTION_UNAVAILABLE");
    return null;
  }
  const pointer = read(file);
  if (!/^direction-[a-f0-9]{24}$/.test(pointer.directionId || "")) fail("Project direction pointer is invalid.", "INVALID_PROJECT_DIRECTION");
  return verify(read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "revisions", `${pointer.directionId}.json`)), project);
}

export function readProjectDirectionRevision({ root = ".", directionId, storage } = {}) {
  if (!/^direction-[a-f0-9]{24}$/.test(directionId || "")) fail("Invalid Project direction id.", "INVALID_PROJECT_DIRECTION");
  storage ??= directionStorage(root);
  const project = read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json"));
  if (project.projectRoot !== fs.realpathSync(path.resolve(root))) fail("Project identity differs.", "PROJECT_IDENTITY_MISMATCH");
  return verify(read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "revisions", `${directionId}.json`)), project);
}

function normalized(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["goal", "constraints", "decisions", "cancelledActions"].includes(key))) fail("Expected current caller-supplied Project direction.", "INVALID_PROJECT_DIRECTION_INPUT");
  if (typeof input.goal !== "string") fail("Project goal must be text.", "INVALID_PROJECT_DIRECTION_INPUT");
  const result = { goal: input.goal };
  for (const key of ["constraints", "decisions", "cancelledActions"]) {
    const values = input[key] || [];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) fail(`${key} must contain text.`, "INVALID_PROJECT_DIRECTION_INPUT");
    result[key] = [...new Set(values)];
  }
  return result;
}

export function updateProjectDirection({ root = ".", expectedDirectionId = null, input, storage } = {}) {
  const direction = normalized(input);
  storage ??= directionStorage(root);
  return withProjectMutation({ root, storage, scope: "project-direction" }, () => {
    const current = readProjectDirection({ root, storage });
    if (current && hash(current.input) === hash(direction)
      && [current.directionId, current.previousDirectionId].includes(expectedDirectionId)) return { status: "reused", direction: current };
    if ((current?.directionId || null) !== expectedDirectionId) fail("Common Project direction changed; derive against its current exact basis.", "PROJECT_DIRECTION_CONFLICT");
    if (current && hash(current.input) === hash(direction)) return { status: "reused", direction: current };
    const project = read(safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project.json"));
    const payload = { schemaVersion: 1, kind: "ProjectDirection", authorityPlane: "P2", authorityBoundary: artifactAuthorityBoundary("ProjectDirection"), projectId: project.projectId,
      previousDirectionId: current?.directionId || null, input: direction,
      source: "explicit-current-user-direction-conveyed-by-caller", grantsExecutionAuthorization: false };
    const directionHash = hash(payload);
    const record = { ...payload, directionId: `direction-${directionHash.slice(0, 24)}`, directionHash };
    const revision = safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "revisions", `${record.directionId}.json`);
    fs.mkdirSync(path.dirname(revision), { recursive: true });
    if (fs.existsSync(revision)) {
      if (hash(read(revision)) !== hash(record)) fail("Direction revision collision.", "PROJECT_DIRECTION_INTEGRITY_FAILURE");
    } else atomicCreateArtifact(revision, `${JSON.stringify(record, null, 2)}\n`);
    const file = safeSessionPath(root, formatForVerifiedOwner(storage).directory, "project-direction", "current.json");
    atomicWriteArtifact(file, `${JSON.stringify({ directionId: record.directionId })}\n`);
    noteProjectGraphChange(root);
    return { status: "updated", direction: record };
  });
}

export function assertProjectActionsCurrent({ root = ".", actions = [], storage } = {}) {
  const direction = readProjectDirection({ root, storage });
  const cancelled = new Set(direction?.input.cancelledActions || []);
  if (actions.some((action) => cancelled.has(action))) fail("Current common Project direction cancels this action.", "PROJECT_ACTION_CANCELLED");
  return direction;
}

export function assertAuthorizationProjectDirection(root, authorization, storage = undefined) {
  const current = readProjectDirection({ root, storage });
  if ((authorization.currentProjectDirectionId || null) !== (current?.directionId || null)) fail("Execution authorization predates the current common Project direction; reassess only this effect against current user direction.", "RUNTIME_PROJECT_DIRECTION_DRIFT");
  return current;
}
