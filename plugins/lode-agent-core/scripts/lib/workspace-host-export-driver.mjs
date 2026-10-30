import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_HOST_COORDINATION_VERSION } from "./workspace-host-coordination.mjs";

export const WORKSPACE_HOST_EXPORT_VERSION = "0.4.0";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const id = (value) => {
  if (typeof value !== "string" || !ID.test(value)) fail("Invalid Host identity.", "INVALID_WORKSPACE_HOST_EXPORT_IDENTITY");
  return value;
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const within = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("Host directory must be absolute.", "INVALID_WORKSPACE_HOST_EXPORT_PATH");
  try {
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    return fs.realpathSync(value);
  } catch { fail("Host directory is unavailable or unsafe.", "INVALID_WORKSPACE_HOST_EXPORT_PATH"); }
}
function roots({ exportRoot, projectRoot }) {
  const project = directory(projectRoot), exported = directory(exportRoot);
  if (within(project, exported) || within(exported, project)) fail("Host export and project overlap.", "WORKSPACE_HOST_EXPORT_PROJECT_OVERLAP");
  return { exportRoot: exported, projectRoot: project };
}
function safe(root, ...parts) {
  const file = path.resolve(root, ...parts);
  if (!within(root, file)) fail("Host path escapes its root.", "WORKSPACE_HOST_EXPORT_PATH_ESCAPE");
  let current = root;
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) fail("Host path contains a symbolic link.", "INVALID_WORKSPACE_HOST_EXPORT_PATH");
  }
  return file;
}
function paths(root) {
  const base = safe(root, "workspace-host-export", "v2");
  return { current: safe(root, path.relative(root, base), "current.json") };
}
function read(root, file, optional = false) {
  safe(root, path.relative(root, file));
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 131072) fail("Unsafe Host record.", "INVALID_WORKSPACE_HOST_EXPORT_FILE");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    fail("Host record is unavailable or invalid.", "INVALID_WORKSPACE_HOST_EXPORT_FILE");
  }
}
function write(root, file, value) {
  safe(root, path.relative(root, file)); fs.mkdirSync(path.dirname(file), { recursive: true });
  safe(root, path.relative(root, file));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 131072) fail("Host record exceeds its limit.", "WORKSPACE_HOST_EXPORT_SIZE_LIMIT");
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return true;
}
export function workspaceHostExportProcessProofHash(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,512}$/u.test(value)) fail("Invalid Host process proof.", "INVALID_WORKSPACE_HOST_PROCESS_PROOF");
  return digest(`workspace-host-export-process-proof\0${value}`);
}
function endpoint(value, proof = false) {
  if (!value || !new Set(["claude", "codex", "opencode"]).has(value.runtime) || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)
    || proof && !SHA.test(value.processProofHash || "")) fail("Invalid Host endpoint.", "INVALID_WORKSPACE_HOST_EXPORT_ENDPOINT");
  const result = { workspaceId: id(value.workspaceId), tabId: id(value.tabId), endpointId: id(value.endpointId), terminalId: id(value.terminalId), cwd: value.cwd, runtime: value.runtime };
  return proof ? { ...result, processProofHash: value.processProofHash } : result;
}
function snapshot(value) {
  if (value?.kind !== "WorkspaceHostExportSnapshot" || value.protocol?.version !== WORKSPACE_HOST_EXPORT_VERSION || !Array.isArray(value.endpoints)) fail("Invalid Host snapshot.", "INVALID_WORKSPACE_HOST_EXPORT_SNAPSHOT");
  id(value.hostInstanceId); id(value.snapshotSequence);
  const endpoints = value.endpoints.map(item => endpoint(item, true));
  for (const key of ["endpointId", "terminalId", "processProofHash"]) if (new Set(endpoints.map(item => item[key])).size !== endpoints.length) fail("Host endpoint ownership is not unique.", "INVALID_WORKSPACE_HOST_EXPORT_ENDPOINT");
  return { ...value, endpoints };
}
export function publishWorkspaceHostExportSnapshot({ exportRoot, projectRoot, hostInstanceId, endpoints, storage } = {}) {
  const scope = roots({ exportRoot, projectRoot }); const file = paths(scope.exportRoot).current;
  const value = snapshot({ schemaVersion: 1, kind: "WorkspaceHostExportSnapshot", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-workspace-host-export"), version: WORKSPACE_HOST_EXPORT_VERSION }, hostInstanceId: id(hostInstanceId), snapshotSequence: `snapshot-${crypto.randomUUID()}`, endpoints });
  for (const item of value.endpoints) if (!within(scope.projectRoot, directory(item.cwd))) fail("Host endpoint is outside project.", "WORKSPACE_HOST_PROJECT_MISMATCH");
  const existing = read(scope.exportRoot, file, true);
  if (existing && existing.hostInstanceId === value.hostInstanceId && json(snapshot(existing).endpoints) === json(value.endpoints)) return existing;
  write(scope.exportRoot, file, value); return value;
}
const current = scope => snapshot(read(scope.exportRoot, paths(scope.exportRoot).current));
export function createWorkspaceHostExportDriver({ exportRoot, projectRoot, caller, processProof, storage } = {}) {
  const scope = roots({ exportRoot, projectRoot }), proof = workspaceHostExportProcessProofHash(processProof);
  if (!caller) fail("Host caller is required.", "WORKSPACE_HOST_PROCESS_PROOF_MISMATCH");
  [caller.workspaceId, caller.tabId, caller.endpointId].forEach(id);
  const bound = () => {
    const value = current(scope);
    const selected = value.endpoints.filter(item => ["workspaceId", "tabId", "endpointId"].every(key => item[key] === caller[key]));
    if (selected.length !== 1 || !crypto.timingSafeEqual(Buffer.from(selected[0].processProofHash, "hex"), Buffer.from(proof, "hex"))) fail("Host process does not own this endpoint.", "WORKSPACE_HOST_PROCESS_PROOF_MISMATCH");
    return value;
  };
  const descriptor = { schemaVersion: 1, kind: "WorkspaceHostDriverDescriptor", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-workspace-host-driver"), version: WORKSPACE_HOST_COORDINATION_VERSION }, hostKind: "host-export", transport: "filesystem-snapshot", providerNeutral: true, tuiScraping: false, providerSessionIdentityPersisted: false, deliverySupported: false };
  return Object.freeze({
    describe() { return descriptor; },
    snapshot() { const value = bound(); return { schemaVersion: 1, kind: "WorkspaceHostSnapshot", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-workspace-host-snapshot"), version: WORKSPACE_HOST_COORDINATION_VERSION }, hostKind: descriptor.hostKind, transport: descriptor.transport, hostInstanceId: value.hostInstanceId, snapshotSequence: value.snapshotSequence, endpoints: value.endpoints.map(item => ({ ...endpoint(item), ownershipId: item.processProofHash })) }; },
    send() { fail("Host export is attachment-only; use ordinary Host messaging.", "WORKSPACE_HOST_EXPORT_DELIVERY_UNSUPPORTED"); },
  });
}
