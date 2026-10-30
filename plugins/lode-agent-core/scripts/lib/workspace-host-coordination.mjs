import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const lineageFormat = record => familyFormatForOriginal({ sessionIdentity: true }, record);
import fs from "node:fs";
import path from "node:path";
import { buildWorkspaceHostProbe, validateWorkspaceHostAdapter, verifiedWorkspaceHostDescriptor } from "./runtime-adapter.mjs";

export const WORKSPACE_HOST_COORDINATION_VERSION = "0.2.0";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RUNTIMES = new Set(["claude", "codex", "opencode"]);
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const requiredId = (value) => {
  if (typeof value !== "string" || !ID.test(value)) fail("Host identity is invalid.", "INVALID_WORKSPACE_HOST_IDENTITY");
  return value;
};
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const directory = (value, { optionalAvailability = false } = {}) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("Host directory must be absolute.", "INVALID_WORKSPACE_HOST_PATH");
  let stat;
  try { stat = fs.lstatSync(value); }
  catch {
    if (optionalAvailability) return null;
    fail("Host directory is unavailable.", "INVALID_WORKSPACE_HOST_PATH");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Host directory is unsafe.", "INVALID_WORKSPACE_HOST_PATH");
  try { return fs.realpathSync(value); }
  catch {
    if (optionalAvailability) return null;
    fail("Host directory is unavailable.", "INVALID_WORKSPACE_HOST_PATH");
  }
};
function boundary(value) {
  if (!value || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.role || "")) fail("Host role is invalid.", "INVALID_WORKSPACE_HOST_BOUNDARY");
  const format = lineageFormat(value);
  if (!format) fail("Host identity is invalid.", "INVALID_WORKSPACE_HOST_IDENTITY");
  return { projectId: requiredId(value.projectId), [format.sessionIdField]: requiredId(value[format.sessionIdField]), role: value.role, projectRoot: directory(value.projectRoot) };
}
function endpoint(value) {
  if (!value || !RUNTIMES.has(value.runtime) || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) fail("Host endpoint is invalid.", "INVALID_WORKSPACE_HOST_SNAPSHOT");
  return { workspaceId: requiredId(value.workspaceId), tabId: requiredId(value.tabId), endpointId: requiredId(value.endpointId), terminalId: requiredId(value.terminalId), cwd: value.cwd, runtime: value.runtime,
    ...(value.ownershipId === undefined ? {} : { ownershipId: requiredId(value.ownershipId) }) };
}
const sameEndpoint = (left, right) => ["workspaceId", "tabId", "endpointId", "terminalId", "cwd", "runtime", "ownershipId"].every(key => left[key] === right[key]);
function attachment(value, scope) {
  const format = lineageFormat(scope);
  if (!value || value.kind !== "WorkspaceHostAttachmentEvidence"
    || !lineageFormat(value) || lineageFormat(value).dialect !== format.dialect
    || ["projectId", format.sessionIdField, "role"].some(key => value[key] !== scope[key])
    || value.instructionAuthority !== false || value.mutatesCanon !== false || value.providerSessionIdentityPersisted !== false) {
    fail("Host attachment belongs to another Project/Session or role.", "STALE_WORKSPACE_HOST_ATTACHMENT");
  }
  endpoint(value); requiredId(value.hostInstanceId);
  if (!within(scope.projectRoot, path.resolve(value.cwd))) fail("Host endpoint is outside the project.", "WORKSPACE_HOST_PROJECT_MISMATCH");
  return value;
}
function attachmentAvailable(value, scope) {
  const currentDirectory = directory(value.cwd, { optionalAvailability: true });
  if (currentDirectory === null) return false;
  if (!within(scope.projectRoot, currentDirectory)) fail("Host endpoint is outside the project.", "WORKSPACE_HOST_PROJECT_MISMATCH");
  return true;
}

// Optional endpoint adapter only. Ordinary delegation uses the Host's own tasks,
// messages and progress; HEAD does not create role inboxes or capability tokens.
export class VerifiedWorkspaceHostAdapter {
  constructor({ driver } = {}) {
    if (!driver || ["describe", "snapshot", "send"].some(key => typeof driver[key] !== "function")) fail("A describe/snapshot/send Host driver is required.", "INVALID_WORKSPACE_HOST_DRIVER");
    const description = driver.describe();
    const format = familyFormatForOriginal("head-agent-core-workspace-host-driver", description);
    if (description?.kind !== "WorkspaceHostDriverDescriptor" || description.providerNeutral !== true || description.tuiScraping !== false || description.providerSessionIdentityPersisted !== false
      || !format || description.protocol?.name !== format.protocol("head-agent-core-workspace-host-driver") || description.protocol?.version !== WORKSPACE_HOST_COORDINATION_VERSION) fail("Invalid Host driver.", "INVALID_WORKSPACE_HOST_DRIVER");
    requiredId(description.hostKind); requiredId(description.transport);
    this.driver = driver; this.driverDescriptor = description; this.format = format;
    this.detachedAttachments = new WeakSet();
    validateWorkspaceHostAdapter(this);
  }
  describe() { return verifiedWorkspaceHostDescriptor({ deliverySupported: this.driverDescriptor.deliverySupported !== false }); }
  probe() { return buildWorkspaceHostProbe(this.describe(), this.format); }
  snapshot() {
    const snapshot = this.driver.snapshot();
    if (snapshot?.kind !== "WorkspaceHostSnapshot" || snapshot.protocol?.name !== this.format.protocol("head-agent-core-workspace-host-snapshot")
      || snapshot.protocol?.version !== WORKSPACE_HOST_COORDINATION_VERSION || snapshot.hostKind !== this.driverDescriptor.hostKind || snapshot.transport !== this.driverDescriptor.transport || !Array.isArray(snapshot.endpoints)) fail("Invalid Host snapshot.", "INVALID_WORKSPACE_HOST_SNAPSHOT");
    requiredId(snapshot.hostInstanceId); requiredId(snapshot.snapshotSequence);
    const endpoints = snapshot.endpoints.map(endpoint);
    if (new Set(endpoints.map(item => `${item.workspaceId}/${item.tabId}/${item.endpointId}`)).size !== endpoints.length) fail("Duplicate Host endpoint.", "INVALID_WORKSPACE_HOST_SNAPSHOT");
    return { ...snapshot, endpoints };
  }
  live(snapshot, value) {
    if (snapshot.hostInstanceId !== value.hostInstanceId) return null;
    return snapshot.endpoints.find(item => sameEndpoint(item, value)) || null;
  }
  attach({ caller, boundary: value } = {}) {
    const scope = boundary(value);
    if (!caller) fail("Host caller is required.", "STALE_WORKSPACE_HOST_CALLER");
    [caller.workspaceId, caller.tabId, caller.endpointId].forEach(requiredId);
    const snapshot = this.snapshot();
    const selected = snapshot.endpoints.filter(item => ["workspaceId", "tabId", "endpointId"].every(key => item[key] === caller[key]));
    if (selected.length !== 1) fail("Host caller is not one exact live endpoint.", "STALE_WORKSPACE_HOST_CALLER");
    if (!within(scope.projectRoot, directory(selected[0].cwd))) fail("Host endpoint is outside the project.", "WORKSPACE_HOST_PROJECT_MISMATCH");
    return { kind: "WorkspaceHostAttachmentEvidence", projectId: scope.projectId, [lineageFormat(scope).sessionIdField]: scope[lineageFormat(scope).sessionIdField], role: scope.role,
      hostInstanceId: snapshot.hostInstanceId, ...selected[0], providerSessionIdentityPersisted: false, instructionAuthority: false, mutatesCanon: false };
  }
  send({ attachment: value, boundary: rawScope, message } = {}) {
    if (this.driverDescriptor.deliverySupported === false) return { status: "unsupported", reason: "host-attachment-only" };
    const scope = boundary(rawScope); attachment(value, scope);
    if (!message || message.projectId !== scope.projectId || !lineageFormat(message) || lineageFormat(message).dialect !== lineageFormat(scope).dialect
      || message[lineageFormat(scope).sessionIdField] !== scope[lineageFormat(scope).sessionIdField] || message.toRole !== scope.role
      || typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content) > 8192 || message.instructionAuthority !== false || message.mutatesCanon !== false) fail("Host message is invalid or outside the current scope.", "INVALID_WORKSPACE_HOST_MESSAGE");
    requiredId(message.messageId);
    if (!attachmentAvailable(value, scope)) return { status: "unavailable", endpointId: value.endpointId };
    if (this.detachedAttachments.has(value)) return { status: "unavailable", endpointId: value.endpointId };
    let selected;
    try { selected = this.live(this.snapshot(), value); }
    catch { return { status: "unavailable", endpointId: value.endpointId }; }
    if (!selected) return { status: "unavailable", endpointId: value.endpointId };
    let acknowledgement;
    try { acknowledgement = this.driver.send({ endpoint: selected, messageId: message.messageId, text: message.content }); }
    catch { return { status: "ambiguous", endpointId: value.endpointId }; }
    let fresh;
    try { fresh = attachmentAvailable(value, scope) && this.live(this.snapshot(), value); }
    catch { return { status: "ambiguous", endpointId: value.endpointId }; }
    const acknowledged = acknowledgement?.status === "delivered" && acknowledgement.messageId === message.messageId
      && acknowledgement.hostInstanceId === value.hostInstanceId && ["workspaceId", "tabId", "endpointId", "terminalId"].every(key => acknowledgement[key] === value[key]);
    return { status: acknowledged && fresh ? "delivered" : "ambiguous", endpointId: value.endpointId };
  }
  receive({ attachment: value, boundary: rawScope } = {}) {
    const scope = boundary(rawScope); attachment(value, scope);
    if (!attachmentAvailable(value, scope)) return { status: "unavailable", endpointId: value.endpointId };
    try { return { status: !this.detachedAttachments.has(value) && this.live(this.snapshot(), value) ? "attached" : "unavailable", endpointId: value.endpointId }; }
    catch { return { status: "unavailable", endpointId: value.endpointId }; }
  }
  detach({ attachment: value, boundary: rawScope } = {}) {
    const scope = boundary(rawScope); attachment(value, scope);
    const available = attachmentAvailable(value, scope);
    let endpointWasLive = false;
    try { endpointWasLive = available && !!this.live(this.snapshot(), value); } catch {}
    this.detachedAttachments.add(value);
    return { status: "detached", endpointId: value.endpointId, endpointWasLive };
  }
}
