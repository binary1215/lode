import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withSessionRoute } from "./session-routing.mjs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution, buildRuntimeResultPacketDraft, verifyRuntimeInvocationLifecycleReceipt } from "./runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch, readBoundedWorkerDispatch } from "./bounded-worker-dispatch.mjs";
import { inspectRuntimeExecutionLease, readRuntimeExecutionSettlement, resolveRuntimeOperationalStateRoot, RUNTIME_OPERATIONAL_STATE_ENV, RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV } from "./runtime-execution-lease.mjs";
import { readRuntimeInvocationRecord, persistRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { readRuntimeOutputSpool } from "./runtime-output-spool.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { verifyWorkerWorkspace, collectWorkerWorkspacePatch } from "./worker-workspace.mjs";
import { verifyWorkerPatchCandidate } from "./worker-patch-basis.mjs";
import { verifyCodexWorkerPolicyPlan, inspectCodexWorkerPolicyCapability, withCodexWorkerPolicyCapability } from "./runtime-codex-worker-policy.mjs";
import { verifyCodexFreshProposalPolicyPlan } from "./runtime-codex-proposal-policy.mjs";
import { verifyCodexNativePrefixPolicyPlan } from "./runtime-codex-prefix-policy.mjs";
import { buildWorkerPatchProposalCandidate, isWorkerPatchProposalMode } from "./worker-patch-proposal.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const ownerFile = path.join(pluginRoot, "scripts", "worker-job-owner.mjs");
const codexRunnerFile = path.join(pluginRoot, "scripts", "lib", "runtime-codex-worker-runner.mjs");
const codexProposalRunnerFile = path.join(pluginRoot, "scripts", "lib", "runtime-codex-proposal-runner.mjs");
const hosts = new WeakMap();
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value));
const fail = (message, code = "WORKER_JOB_CONFLICT") => { throw Object.assign(new Error(message), { code }); };
const nativeLaunchPath = (file) => process.platform === "win32" ? path.toNamespacedPath(file) : file;
const operationalEnvironmentNames = [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV, RUNTIME_OPERATIONAL_STATE_ENV];
const operationalEnvironmentName = key => operationalEnvironmentNames.find(name => name.toLowerCase() === key.toLowerCase());
const proposalMode = authorization => isWorkerPatchProposalMode(authorization.workerInput?.executionBoundary?.mode);
const proposalPolicy = policy => ["CodexFreshProposalPolicyPlan", "CodexNativePrefixPolicyPlan"].includes(policy?.kind);
const verifyProposalPolicy = policy => policy?.kind === "CodexNativePrefixPolicyPlan" ? verifyCodexNativePrefixPolicyPlan(policy) : verifyCodexFreshProposalPolicyPlan(policy);

function regularBytes(file, limit, publicationAlias = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail("Unsafe worker job file.");
  // The only legitimate second name is an interrupted create-only publication.
  if (stat.nlink !== 1) {
    if (!publicationAlias) fail("Unexpected worker job hardlink.");
    try {
      const alias = fs.lstatSync(`${file}.pending`);
      if (stat.nlink !== 2 || !alias.isFile() || alias.isSymbolicLink() || alias.nlink !== 2 || alias.ino !== stat.ino || alias.dev !== stat.dev) fail("Unexpected worker job alias.");
    } catch (error) {
      const latest = fs.lstatSync(file);
      if (error.code !== "ENOENT" || latest.nlink !== 1 || latest.ino !== stat.ino || latest.dev !== stat.dev) throw error;
    }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) fail("Worker job file changed.");
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) fail("Worker job file was truncated."); offset += n; }
    const after = fs.fstatSync(fd);
    if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) fail("Worker job file changed during read.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function read(file, limit = 8 * 1024 * 1024) { return JSON.parse(regularBytes(file, limit, true)); }
function publish(file, value) {
  const pending = `${file}.pending`;
  const fd = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(fd, encode(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(pending, file);
  fs.unlinkSync(pending);
}
function jobDirectory(operationalRoot, authorization, create = false) {
  let directory = operationalRoot;
  for (const segment of ["worker-jobs", authorization.projectId, authorization.authorizationId]) {
    directory = path.join(directory, segment);
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    if (!fs.existsSync(directory) && !create) continue;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail("Worker job directory is unsafe.");
  }
  return directory;
}
function codeIdentity(runnerFile, hostModuleFile = null) {
  const files = [ownerFile, runnerFile, ...(hostModuleFile ? [hostModuleFile] : [])];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) fail("Worker owner code cannot contain linked modules.");
      if (entry.isDirectory()) collect(path.join(directory, entry.name));
      else if (entry.name.endsWith(".mjs")) files.push(path.join(directory, entry.name));
    }
  }
  collect(path.join(pluginRoot, "scripts", "lib"));
  return hash(encode([...new Set(files)].sort().map((file) => [file, hash(regularBytes(file, 4 * 1024 * 1024))])));
}

// Trusted Host composition, never accepted from CLI/MCP JSON. A Codex policy
// plan is intent only: it additionally requires an opaque verifier connection
// and an exact Host module which can reconnect that verifier inside the owner.
// Fresh proposal mode instead reconnects one fixed concrete backend. Its plan
// remains intent, not proof of enforcement or permission to write selected files.
export function createBoundedWorkerJobHost({ runnerFile, policy, environment = {}, workspaceBinding = null,
  codexPolicyCapability = null, hostModuleFile = null, hostConnection = null } = {}) {
  if (!environment || typeof environment !== "object" || Object.entries(environment).some(([k, v]) => !k || k.includes("=") || k.includes("\0") || typeof v !== "string" || v.includes("\0"))) fail("Invalid Host runner environment.");
  const codex = policy?.kind === "CodexWorkerPolicyPlan";
  if (hostConnection !== null && (!codex || !hostModuleFile
    || fs.realpathSync(hostModuleFile) !== fs.realpathSync(path.join(pluginRoot, "scripts/lib/runtime-codex-worker-host.mjs"))
    || encode(hostConnection).length > 1024 * 1024)) fail("Host reconnect data requires the fixed native composition.", "WORKER_JOB_POLICY_UNAVAILABLE");
  if (proposalPolicy(policy)) {
    verifyProposalPolicy(policy);
    if (codexPolicyCapability !== null || hostModuleFile !== null
      || runnerFile && fs.realpathSync(runnerFile) !== fs.realpathSync(codexProposalRunnerFile)) fail("Fresh proposal jobs require the fixed backend, not a Host module or alternate runner.", "WORKER_JOB_POLICY_UNAVAILABLE");
    if (!workspaceBinding || workspaceBinding.canonicalRoot === workspaceBinding.executionRoot
      || workspaceBinding.executionRoot !== fs.realpathSync(workspaceBinding.executionRoot)) fail("Fresh proposal jobs require their separate selected workspace.");
    const { bindingDigest, ...payload } = workspaceBinding;
    if (bindingDigest !== hash(encode(payload))) fail("Fresh proposal workspace binding changed.");
    runnerFile = codexProposalRunnerFile;
    // Node's loader flags would run before this fixed owner can verify code or
    // policy. A proposal Host may bind its existing home, not inject startup
    // modules through NODE_OPTIONS, NODE_PATH, or an arbitrary environment.
    if (Object.keys(environment).some(key => key.toLowerCase() !== "codex_home")) fail("Fresh proposal owner accepts only its exact CODEX_HOME environment binding.", "WORKER_JOB_POLICY_UNAVAILABLE");
    const homes = Object.keys(environment).filter(key => key.toLowerCase() === "codex_home");
    if (homes.length > 1 || homes.some(key => environment[key] !== policy.codexHome)) fail("Fresh proposal Host environment differs from its frozen CODEX_HOME.");
    environment = { ...environment };
    for (const key of homes) delete environment[key];
    environment.CODEX_HOME = policy.codexHome;
  } else if (codex) {
    verifyCodexWorkerPolicyPlan(policy);
    const proof = inspectCodexWorkerPolicyCapability(codexPolicyCapability);
    if (encode(proof.policy).compare(encode(policy)) || encode(proof.workspaceBinding).compare(encode(workspaceBinding))) fail("The Codex Host proof differs from its frozen workspace policy.");
    if (!hostModuleFile || runnerFile && fs.realpathSync(runnerFile) !== fs.realpathSync(codexRunnerFile)) fail("Codex selected execution requires the fixed runner and trusted reconnect module.", "WORKER_JOB_POLICY_UNAVAILABLE");
    runnerFile = codexRunnerFile;
    hostModuleFile = fs.realpathSync(path.resolve(hostModuleFile));
    regularBytes(hostModuleFile, 1024 * 1024);
  } else if (policy?.kind !== "protocol-fixture" || policy.actualProviderInvoked !== false || codexPolicyCapability !== null || hostModuleFile !== null) fail("An effective actual-provider job policy adapter is not available.", "WORKER_JOB_POLICY_UNAVAILABLE");
  if (encode(policy).length > 64 * 1024) fail("Host policy binding exceeds its bound.");
  const runner = fs.realpathSync(path.resolve(runnerFile));
  regularBytes(runner, 1024 * 1024);
  const capability = Object.freeze(Object.create(null));
  hosts.set(capability, { runnerFile: runner, policy: JSON.parse(JSON.stringify(policy)), environment: { ...environment },
    codexPolicyCapability, hostModuleFile, hostModuleDigest: hostModuleFile ? hash(regularBytes(hostModuleFile, 1024 * 1024)) : null,
    hostConnection: hostConnection === null ? null : JSON.parse(JSON.stringify(hostConnection)),
    workspaceBinding: workspaceBinding === null ? null : JSON.parse(JSON.stringify(workspaceBinding)) });
  return capability;
}
function identity(root, authorizationId) {
  const projectRoot = fs.realpathSync(root);
  const { authorization } = readRuntimeInvocationAuthorization({ root: projectRoot, authorizationId });
  if (!authorization.workerInput) fail("Detached jobs require a retained member input.", "WORKER_JOB_INPUT_REQUIRED");
  if (hash(projectRoot) !== authorization.projectRootDigest) fail("Worker job Project root differs.");
  return { projectRoot, authorization };
}
function current(root, authorization) {
  return prepareRuntimeInvocationExecution({ root, authorization, sessionRequest: authorization.workerInput.sessionRequest ?? "" });
}
function workspaceBoundary(authorization, projectRoot, policy, workspaceBinding, inspectFiles = false) {
  const boundary = authorization.workerInput.executionBoundary;
  if (proposalMode(authorization)) {
    // Historical result inspection binds the original policy bytes, not today's
    // executable/cache/home state. Those are revalidated for new execution only.
    if (inspectFiles) verifyProposalPolicy(policy);
    if (!proposalPolicy(policy) || policy.protocolVersion !== "0.1.0"
      || policy.mode !== boundary.mode || policy.workspaceMode !== "read-only"
      || !["actual-provider", "protocol-fixture"].includes(policy.evidenceMode)
      || policy.enforcementVerified !== false || policy.recoveryAuthority !== false
      || policy.promotionAuthority !== false || policy.instructionAuthority !== false) fail("Proposal binding does not retain an explicit authority-free read-only policy.");
    if (authorization.protocolVersion !== "0.7.0" || authorization.runtime !== "codex" || authorization.workspaceMode !== "read-only"
      || authorization.workerInput.writeBasis || !authorization.workerInput.proposalBasis
      || boundary.ownedPaths.length !== 0) fail("A proposal job cannot acquire workspace-write authority.");
  } else if (proposalPolicy(policy)) fail("Proposal policy cannot reinterpret another worker mode.");
  if (!boundary) {
    if (workspaceBinding) fail("An unbound authorization cannot acquire a child workspace.");
    return projectRoot;
  }
  if (!workspaceBinding || workspaceBinding.canonicalRoot !== projectRoot
    || workspaceBinding.bindingDigest !== boundary.workspaceBindingDigest
    || workspaceBinding.executionRootDigest !== boundary.executionRootDigest
    || workspaceBinding.sourceBasisDigest !== boundary.sourceBasisDigest
    || hash(encode(policy)) !== boundary.policyDigest) fail("Host workspace/policy differs from the pre-authorized worker input.");
  const { bindingDigest, ...payload } = workspaceBinding;
  if (hash(encode(payload)) !== bindingDigest || hash(workspaceBinding.executionRoot) !== boundary.executionRootDigest) fail("Host workspace binding changed.");
  if (inspectFiles) verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis: authorization.workerInput.sourceBasis, storage: originalFormat(authorization) });
  return workspaceBinding.executionRoot;
}
function frozenProviderProposal({ projectRoot, authorization, binding, record }) {
  const settlement = readRuntimeExecutionSettlement({ projectRoot, authorization });
  if (!settlement || settlement.release.operationStatus === "threw" || record.receipt.status !== "completed"
    || record.authorization.authorizationHash !== authorization.authorizationHash
    || record.receipt.inputDigestObserved !== authorization.executionInput.digest
    || record.receipt.processBoundary.callerFenceDigest !== settlement.consumption.ownerFenceDigest
    || settlement.release.lifecycleReceiptId !== record.receipt.receiptId
    || settlement.consumption.consumptionId !== record.receipt.executionLeaseConsumptionId
    || record.draft.executionLeaseConsumptionId !== settlement.consumption.consumptionId
    || record.draft.executionLeaseReleaseId !== settlement.release.releaseId) fail("Provider proposal requires its exact completed invocation and settled lease.");
  // No filesystem diff: candidate bytes come exclusively from the verified,
  // receipt-bound structured result. P5 can reconstruct this same evidence after
  // publication loss without claiming the original owner wrote a patch file.
  const candidate = buildWorkerPatchProposalCandidate({ authorization, structuredResult: record.draft.providerResult });
  return { origin: "provider-patch-proposal", authorizationHash: authorization.authorizationHash,
    inputDigest: authorization.executionInput.digest, workspaceBindingDigest: binding.workspaceBinding.bindingDigest,
    lifecycleReceiptId: record.receipt.receiptId,
    source: { kind: "settled-runtime-result", draftId: record.draft.draftId, draftHash: record.draft.draftHash,
      receiptHash: record.receipt.receiptHash, executionLeaseConsumptionId: settlement.consumption.consumptionId,
      executionLeaseReleaseId: settlement.release.releaseId }, candidate };
}
function publishProviderProposal(directory, frozenPatch) {
  const file = path.join(directory, "workspace-patch.json");
  const limit = frozenPatch.candidate.maxBytes * 4 + 1024 * 1024;
  if (!fs.existsSync(file)) {
    try { publish(file, frozenPatch); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.existsSync(file)) {
        // A complete identical pending publication can be linked after owner
        // exit. Do not overwrite or discard partial/divergent pending evidence.
        if (hash(encode(read(`${file}.pending`, limit))) !== hash(encode(frozenPatch))) fail("Pending provider proposal differs from settled result evidence.");
        try { fs.linkSync(`${file}.pending`, file); } catch (linkError) { if (linkError.code !== "EEXIST") throw linkError; }
      }
    }
  }
  if (hash(encode(read(file, limit))) !== hash(encode(frozenPatch))) fail("Retained provider proposal differs from settled result evidence.");
}
function verifiedBinding(directory, projectRoot, authorization) {
  const record = read(path.join(directory, "binding.json"));
  const { bindingDigest, ...binding } = record;
  if (hash(encode(binding)) !== bindingDigest || binding.projectRoot !== projectRoot
    || binding.authorizationId !== authorization.authorizationId || binding.authorizationHash !== authorization.authorizationHash
    || binding.inputDigest !== authorization.executionInput.digest || binding.taskKey !== authorization.workerInput.taskKey
    || binding.role !== authorization.workerInput.role || binding.operationalRoot !== resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false })
    || binding.policyDigest !== hash(encode(binding.policy))) fail("Worker job binding differs from exact authorization.");
  workspaceBoundary(authorization, projectRoot, binding.policy, binding.workspaceBinding || null);
  const requestBytes = regularBytes(path.join(directory, "request.json"), 8 * 1024 * 1024, true);
  if (hash(requestBytes) !== binding.requestDigest) fail("Worker job request changed.");
  const request = JSON.parse(requestBytes);
  // Retained requests are immutable: accept either historical spelling without
  // rewriting bytes or their bound digest, and never hide a conflicting alias.
  const operationalKeys = Object.keys(request.request.environment).filter(operationalEnvironmentName);
  if (request.deadlineUnixMs !== binding.deadlineUnixMs || request.request.workingDirectory !== projectRoot
    || !operationalEnvironmentNames.some(key => Object.hasOwn(request.request.environment, key))
    || operationalKeys.some(key => request.request.environment[key] !== binding.operationalRoot)) fail("Worker job execution root or deadline differs.");
  if (proposalMode(authorization)) {
    const keys = Object.keys(request.request.environment), expected = new Set(["systemroot", "windir", "temp", "tmp", "codex_home", RUNTIME_OPERATIONAL_STATE_ENV.toLowerCase(), RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV.toLowerCase()]);
    if (keys.some(key => !expected.has(key.toLowerCase())) || new Set(keys.map(key => key.toLowerCase())).size !== keys.length
      || request.request.environment.CODEX_HOME !== binding.policy.codexHome) fail("Fresh proposal owner environment differs from its fixed startup boundary.");
  }
  return { binding: record, request };
}
function processState(binding, directory, onProcess = () => {}, inspectorSelection = null) {
  // The native probe compares a creation token, not just numeric PID presence.
  // Missing/corrupt binaries or access denied remain unknown, never inferred exit.
  try {
    let selection;
    try {
      selection = resolveVerifiedProcessSupervisor({ pluginRoot: path.dirname(binding.supervisorManifestPath), manifestFile: binding.supervisorManifestPath });
      if (selection.manifest.manifestHash !== binding.supervisorManifestDigest) selection = null;
    } catch { selection = null; }
    // Historical inspection is not re-execution. A verified compatible inspector
    // can read the frozen request + creation token after an old cache is replaced.
    if (!selection) selection = inspectorSelection
      ? resolveVerifiedProcessSupervisor({ pluginRoot: path.dirname(inspectorSelection.manifestPath), manifestFile: inspectorSelection.manifestPath })
      : resolveVerifiedProcessSupervisor({ pluginRoot });
    const args = ["--job-state", path.join(directory, "request.json")];
    onProcess({ type: "planned", command: selection.binaryPath, args, cwd: binding.projectRoot, parentPid: process.pid, ports: [] });
    const result = spawnSync(nativeLaunchPath(selection.binaryPath), args, { cwd: binding.projectRoot, windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8" });
    onProcess({ type: "exit", pid: result.pid, parentPid: process.pid, exitCode: result.status, ports: [] });
    if (result.error || result.status !== 0) return "unknown";
    const observed = JSON.parse(result.stdout);
    if (observed.protocolVersion !== "0.1.0" || observed.requestDigest !== binding.requestDigest
      || !["present", "gone", "reused", "unknown"].includes(observed.ownerState)) fail("Worker owner inspection differs from its binding.");
    return observed.ownerState;
  } catch (error) {
    if (error.code === "WORKER_JOB_CONFLICT") throw error;
    return "unknown";
  }
}
async function launch(selection, file, environment, onProcess, spawnImplementation, cwd) {
  return await new Promise((resolve, reject) => {
    onProcess({ type: "planned", parentPid: process.pid, command: selection.binaryPath, args: ["--launch-job", file], cwd, ports: [] });
    const child = spawnImplementation(nativeLaunchPath(selection.binaryPath), ["--launch-job", file], { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    onProcess({ type: "spawn", pid: child.pid, parentPid: process.pid, command: selection.binaryPath, cwd, ports: [] });
    let size = 0;
    const timer = setTimeout(() => child.kill(), 5000);
    let error;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (bytes) => { size += bytes.length; if (size > 64 * 1024) child.kill(); });
      // Windows can emit ENOTCONN on a pipe as well as an error on the child.
      // Settle only after close; an interrupted launcher is not proof of no start.
      stream.on("error", (value) => { error ||= value; child.kill(); });
    }
    child.on("error", (value) => { error = value; });
    child.on("close", (code) => { clearTimeout(timer); onProcess({ type: "exit", pid: child.pid, exitCode: code, ports: [] }); if (error) reject(error); else resolve(code); });
  });
}

export async function startBoundedWorkerJob({ root = ".", authorizationId, role } = {}, { host = null, supervisorSelection = null, onProcess = () => {}, spawnImplementation = spawn } = {}) {
  const { projectRoot, authorization } = identity(root, authorizationId);
  if (role !== authorization.workerInput.role) fail("Worker job role differs.");
  const operationalRoot = resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false });
  const directory = jobDirectory(operationalRoot, authorization);
  if (fs.existsSync(path.join(directory, "binding.json"))) return readBoundedWorkerJob({ root: projectRoot, authorizationId });
  current(projectRoot, authorization);
  const adapter = hosts.get(host);
  if (!adapter) fail("No verified worker job Host is connected; ordinary attached work remains available.", "WORKER_JOB_HOST_UNAVAILABLE");
  for (const [key, value] of Object.entries(adapter.environment)) {
    const name = operationalEnvironmentName(key);
    if (name && value.trim() && resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization),
      environment: { [name]: value }, create: false }) !== operationalRoot) fail("Worker Host operational state alias differs from its bound root.");
  }
  workspaceBoundary(authorization, projectRoot, adapter.policy, adapter.workspaceBinding, true);
  if (adapter.codexPolicyCapability) {
    if (hash(regularBytes(adapter.hostModuleFile, 1024 * 1024)) !== adapter.hostModuleDigest) fail("Trusted Codex Host reconnect code changed after binding.", "WORKER_JOB_CODE_DRIFT");
    const proof = inspectCodexWorkerPolicyCapability(adapter.codexPolicyCapability);
    await withCodexWorkerPolicyCapability({ capability: adapter.codexPolicyCapability, authorization,
      root: projectRoot, target: proof.target }, () => {
      if (hash(regularBytes(adapter.hostModuleFile, 1024 * 1024)) !== adapter.hostModuleDigest) fail("Trusted Codex Host reconnect code changed during verification.", "WORKER_JOB_CODE_DRIFT");
    });
    if (hash(regularBytes(adapter.hostModuleFile, 1024 * 1024)) !== adapter.hostModuleDigest) fail("Trusted Codex Host reconnect code changed after verification.", "WORKER_JOB_CODE_DRIFT");
  }
  if (process.platform !== "win32") fail("Detached nested process ownership is not verified on this platform.", "WORKER_JOB_PLATFORM_UNSUPPORTED");
  const selection = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  createBoundedWorkerDispatch({ root: projectRoot, authorizationId, role });
  const lease = inspectRuntimeExecutionLease({ projectRoot, projectId: authorization.projectId, authorizationId, storage: originalFormat(authorization) });
  if (lease.status !== "available") fail("An existing lease cannot be relaunched by a job.", "WORKER_JOB_ALREADY_CONSUMED");
  resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization) });
  jobDirectory(operationalRoot, authorization, true);
  const deadlineUnixMs = Date.now() + authorization.limits.timeoutMs;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "temp", "tmp"].includes(key.toLowerCase())));
  Object.assign(environment, adapter.environment, { [RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV]: operationalRoot });
  for (const key of Object.keys(environment)) if (operationalEnvironmentName(key) && key !== RUNTIME_OPERATIONAL_STATE_CANONICAL_ENV) delete environment[key];
  const request = { protocolVersion: "0.1.0", timeoutMs: authorization.limits.timeoutMs, deadlineUnixMs,
    maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024,
    request: { schemaVersion: 1, protocolVersion: "0.1.0", executable: process.execPath,
      arguments: [ownerFile, path.join(directory, "binding.json")], workingDirectory: projectRoot,
      environment, inputBase64: "", controlFile: path.join(directory, "control.jsonl"), terminationGraceMs: authorization.limits.terminationGraceMs } };
  const binding = { kind: "BoundedWorkerJobBinding", protocolVersion: "0.1.0", projectRoot, operationalRoot,
    authorizationId, authorizationHash: authorization.authorizationHash, inputDigest: authorization.executionInput.digest,
    taskKey: authorization.workerInput.taskKey, role, runnerFile: adapter.runnerFile, codeDigest: codeIdentity(adapter.runnerFile, adapter.hostModuleFile),
    policy: adapter.policy, policyDigest: hash(encode(adapter.policy)), deadlineUnixMs,
    ...(adapter.workspaceBinding ? { workspaceBinding: adapter.workspaceBinding } : {}),
    ...(adapter.hostModuleFile ? { hostModuleFile: adapter.hostModuleFile, hostModuleDigest: adapter.hostModuleDigest } : {}),
    ...(adapter.hostConnection ? { hostConnection: adapter.hostConnection } : {}),
    supervisorManifestDigest: selection.manifest.manifestHash, supervisorManifestPath: selection.manifestPath,
    requestDigest: hash(encode(request)), recoveryAuthority: false };
  // Pure validation happens first. Claim before publishing the launch request,
  // so concurrent callers or an interrupted start cannot relaunch this attempt.
  try { publish(path.join(directory, "intent.json"), { authorizationId, authorizationHash: authorization.authorizationHash, replayAllowed: false }); }
  catch (error) { if (error.code === "EEXIST") return readBoundedWorkerJob({ root: projectRoot, authorizationId }); throw error; }
  publish(path.join(directory, "request.json"), request);
  publish(path.join(directory, "binding.json"), { ...binding, bindingDigest: hash(encode(binding)) });
  // Failure/ack loss is intentionally not retried. Reconcile the same immutable job.
  await launch(selection, path.join(directory, "request.json"), environment, onProcess, spawnImplementation, projectRoot);
  return readBoundedWorkerJob({ root: projectRoot, authorizationId });
}

export function readBoundedWorkerJob({ root = ".", authorizationId } = {}, { onProcess = () => {}, inspectorSelection = null } = {}) {
  const { projectRoot, authorization } = identity(root, authorizationId);
  readBoundedWorkerDispatch({ root: projectRoot, authorizationId });
  const operationalRoot = resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false });
  const directory = jobDirectory(operationalRoot, authorization);
  const projection = { authorizationId, taskKey: authorization.workerInput.taskKey, status: "not-started", replayAllowed: false,
    recoveryAuthority: false, result: null, ownerExitObserved: false, current: true };
  try { current(projectRoot, authorization); } catch (error) { projection.current = false; projection.currentConflict = error.code; }
  if (!fs.existsSync(directory)) return projection;
  if (!fs.existsSync(path.join(directory, "binding.json"))) return { ...projection, status: "unknown" };
  const { binding } = verifiedBinding(directory, projectRoot, authorization);
  const claim = fs.existsSync(path.join(directory, "claim.json")) ? read(path.join(directory, "claim.json"), 64 * 1024) : null;
  const ack = fs.existsSync(path.join(directory, "launch.json")) ? read(path.join(directory, "launch.json"), 64 * 1024) : null;
  for (const record of [claim, ack]) if (record && record.requestDigest !== binding.requestDigest) fail("Worker owner evidence belongs to another request.");
  if (claim && ack && (claim.pid !== ack.ownerPid || claim.ownerToken && ack.ownerToken && claim.ownerToken !== ack.ownerToken)) fail("Worker owner identities conflict.");
  const ownerState = processState(binding, directory, onProcess, inspectorSelection);
  projection.ownerExitObserved = ownerState === "gone" || ownerState === "reused";
  projection.status = ownerState === "present" ? "running" : "unknown";
  const terminalFile = path.join(directory, "terminal.json");
  if (!fs.existsSync(terminalFile)) return projection;
  const terminal = read(terminalFile, 64 * 1024);
  if (terminal.requestDigest !== binding.requestDigest || terminal.ownerExitRequired !== true || terminal.protocolVersion !== "0.1.0") fail("Invalid worker terminal binding.");
  for (const name of ["stdout", "stderr"]) {
    const bytes = regularBytes(path.join(directory, `${name}.bin`), 1024 * 1024);
    if (terminal[`${name}Bytes`] !== bytes.length || terminal[`${name}Digest`] !== hash(bytes)) fail("Worker terminal output is incomplete or changed.");
  }
  if (!projection.ownerExitObserved) return { ...projection, status: "settling" };
  if (terminal.reason !== "exited" || terminal.completeOutput !== true) return { ...projection, status: terminal.reason === "cancel" ? "cancelled" : terminal.reason === "timeout" ? "timed-out" : "failed" };
  const control = regularBytes(path.join(directory, "control.jsonl"), 64 * 1024);
  if (terminal.controlBytes !== control.length || terminal.controlDigest !== hash(control)) fail("Worker cleanup evidence differs from its terminal.");
  const events = control.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  if (events.length !== 4 || events.map(event => event.type).join(",") !== "supervisor.ready,provider.started,provider.exited,supervisor.cleanup"
    || events.some(event => event.protocolVersion !== "0.1.0") || events[0].treeOwnershipEstablished !== true
    || events[1].treeOwnershipEstablished !== true || events[1].providerPid !== events[2].providerPid
    || events[2].exitCode !== terminal.exitCode || events[3].cleanupAttempted !== true
    || !(events[3].cleanupVerified === true || events[3].kernelCleanupOnExit === true)) fail("Worker tree cleanup is not verified.");
  projection.ownerExitCode = terminal.exitCode;
  const lease = inspectRuntimeExecutionLease({ projectRoot, projectId: authorization.projectId, authorizationId, storage: originalFormat(authorization) });
  if (lease.status !== "consumed-released" || lease.release.operationStatus === "threw") return { ...projection, status: "incomplete" };
  let record;
  try { record = readRuntimeInvocationRecord({ root: projectRoot, authorizationId, storage: originalFormat(authorization) }); }
  catch (error) { if (error.code === "RUNTIME_INVOCATION_RESULT_NOT_FOUND") return { ...projection, status: "incomplete" }; throw error; }
  if (record.receipt.receiptId !== lease.release.lifecycleReceiptId || record.authorization.authorizationHash !== authorization.authorizationHash) fail("Worker result differs from its exact lease.");
  if ((binding.policy.actualProviderInvoked === false || binding.policy.evidenceMode === "protocol-fixture") && record.receipt.providerBoundary.actualProviderInvoked) fail("A fixture cannot claim actual provider execution.");
  let workspacePatch = null;
  if (proposalMode(authorization) && record.receipt.status === "completed") {
    const expected = frozenProviderProposal({ projectRoot, authorization, binding, record });
    const patchFile = path.join(directory, "workspace-patch.json");
    if (!fs.existsSync(patchFile)) return { ...projection, status: "incomplete", workspacePatchStatus: "missing" };
    const frozenPatch = read(patchFile, authorization.limits.maxInputBytes * 4 + 1024 * 1024);
    const frozenDigest = hash(encode(expected));
    if (hash(encode(frozenPatch)) !== frozenDigest) fail("Provider proposal differs from its exact settled structured result.");
    workspacePatch = { origin: expected.origin, candidateId: expected.candidate.candidateId,
      candidateHash: expected.candidate.candidateHash, frozenDigest };
  } else if (authorization.workerInput.writeBasis && record.receipt.status === "completed") {
    const patchFile = path.join(directory, "workspace-patch.json");
    if (!fs.existsSync(patchFile)) return { ...projection, status: "incomplete", workspacePatchStatus: "missing" };
    const frozenPatch = read(patchFile, authorization.limits.maxInputBytes * 4 + 1024 * 1024);
    const ownerLine = regularBytes(path.join(directory, "stdout.bin"), 1024 * 1024).toString("utf8").trim().split("\n").at(-1);
    let ownerResult;
    try { ownerResult = JSON.parse(ownerLine); } catch { fail("Worker patch has no terminal-bound owner result."); }
    if (ownerResult.authorizationId !== authorization.authorizationId || ownerResult.runnerReturned !== true
      || ownerResult.workspacePatchDigest !== hash(encode(frozenPatch))
      || frozenPatch.authorizationHash !== authorization.authorizationHash
      || frozenPatch.inputDigest !== authorization.executionInput.digest
      || frozenPatch.workspaceBindingDigest !== binding.workspaceBinding.bindingDigest
      || frozenPatch.lifecycleReceiptId !== record.receipt.receiptId
      || JSON.stringify(frozenPatch.candidate.basis) !== JSON.stringify(authorization.workerInput.writeBasis)) fail("Worker patch differs from exact owner/input/result evidence.");
    const candidate = verifyWorkerPatchCandidate(frozenPatch.candidate, originalFormat(authorization));
    workspacePatch = { candidateId: candidate.candidateId, candidateHash: candidate.candidateHash, frozenDigest: ownerResult.workspacePatchDigest };
  }
  return { ...projection, status: record.receipt.status === "completed" ? "completed" : "failed",
    ...(workspacePatch ? { workspacePatch } : {}),
    result: { receiptId: record.receipt.receiptId, draftId: record.draft.draftId, actualProviderInvoked: record.receipt.providerBoundary.actualProviderInvoked } };
}

export function cancelBoundedWorkerJob({ root = ".", authorizationId } = {}, inspection = {}) {
  const { projectRoot, authorization } = identity(root, authorizationId);
  const status = readBoundedWorkerJob({ root: projectRoot, authorizationId }, inspection);
  if (status.ownerExitObserved || status.status === "not-started") return status;
  // Protective cancellation narrows an existing exact effect. Source or Session
  // drift forbids new execution/application, not stopping this owned job.
  const directory = jobDirectory(resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false }), authorization);
  const { binding } = verifiedBinding(directory, projectRoot, authorization);
  const file = path.join(directory, "cancel");
  const value = { requestDigest: binding.requestDigest, authorizationId };
  try { publish(file, value); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (JSON.stringify(read(file)) !== JSON.stringify(value)) fail("Cancel request conflicts.");
  return { ...readBoundedWorkerJob({ root: projectRoot, authorizationId }, inspection), cancellationRequested: true };
}

export function readBoundedWorkerPatch({ root = ".", authorizationId } = {}, inspection = {}) {
  const { projectRoot, authorization } = identity(root, authorizationId);
  const state = readBoundedWorkerJob({ root: projectRoot, authorizationId }, inspection);
  if (state.status !== "completed" || !state.workspacePatch) fail("No complete terminal-bound workspace patch is available.", "WORKER_PATCH_NOT_AVAILABLE");
  const directory = jobDirectory(resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false }), authorization);
  const frozen = read(path.join(directory, "workspace-patch.json"), authorization.limits.maxInputBytes * 4 + 1024 * 1024);
  if (hash(encode(frozen)) !== state.workspacePatch.frozenDigest) fail("Worker patch changed during its read.");
  return { authorizationId, authorizationHash: authorization.authorizationHash, inputDigest: authorization.executionInput.digest,
    lifecycleReceiptId: state.result.receiptId, actualProviderInvoked: state.result.actualProviderInvoked,
    ...(frozen.origin ? { origin: frozen.origin, source: frozen.source } : {}),
    candidate: verifyWorkerPatchCandidate(frozen.candidate, originalFormat(authorization)), current: state.current,
    storage: "host-frozen-unintegrated-evidence", applied: false, instructionAuthority: false,
    promotionAuthority: false, recoveryAuthority: false };
}

export function reconcileBoundedWorkerJob(input, inspection = {}) {
  const { projectRoot, authorization } = identity(input.root || ".", input.authorizationId);
  return withProjectMutation({ root: projectRoot, scope: "worker-result-publication" }, () => {
    const status = readBoundedWorkerJob(input, inspection);
    // ownerExitCode is exposed only after native output + tree cleanup validation.
    // An outer Node publication failure may be exit1 despite a successful provider.
    if (!status.ownerExitObserved || !Number.isInteger(status.ownerExitCode)) return status;
    const settlement = readRuntimeExecutionSettlement({ projectRoot, authorization });
    if (!settlement || settlement.release.operationStatus === "threw") return status;
    const operationalRoot = resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false });
    const directory = jobDirectory(operationalRoot, authorization);
    const { binding } = verifiedBinding(directory, projectRoot, authorization);
    if (proposalMode(authorization)) {
      let retained;
      try { retained = readRuntimeInvocationRecord({ root: projectRoot, authorizationId: authorization.authorizationId, storage: originalFormat(authorization) }); }
      catch (error) { if (error.code !== "RUNTIME_INVOCATION_RESULT_NOT_FOUND") throw error; }
      if (retained?.receipt.status === "completed") {
        publishProviderProposal(directory, frozenProviderProposal({ projectRoot, authorization, binding, record: retained }));
        return readBoundedWorkerJob(input, inspection);
      }
    }
    let spool;
    try { spool = readRuntimeOutputSpool({ operationalRoot, authorization }); }
    catch (error) { if (error.code === "ENOENT") return status; throw error; }
    if (spool.status !== "terminal-recorded") return status;
    const { receipt: candidate, events, providerResult } = spool.terminal.result;
    const receipt = verifyRuntimeInvocationLifecycleReceipt(candidate);
    if (receipt.inputDigestObserved !== authorization.executionInput.digest
      || receipt.executionLeaseConsumptionId !== settlement.consumption.consumptionId
      || receipt.receiptId !== settlement.release.lifecycleReceiptId
      || receipt.processBoundary.callerFenceDigest !== settlement.consumption.ownerFenceDigest
      || spool.header.callerFenceDigest !== receipt.processBoundary.callerFenceDigest
      || spool.header.supervisorManifestDigest !== receipt.processBoundary.supervisorManifestDigest
      || ["stdout", "stderr"].some(name => spool.terminal.streams[name].truncated
        || receipt[`${name}Bytes`] !== spool.outputs[name].length || receipt[`${name}Digest`] !== hash(spool.outputs[name]))) fail("Spool differs from exact provider/lease evidence.");
    if ((binding.policy.actualProviderInvoked === false || binding.policy.evidenceMode === "protocol-fixture") && receipt.providerBoundary.actualProviderInvoked) fail("Fixture recovery cannot claim an actual provider.");
    const draft = buildRuntimeResultPacketDraft({ authorization, receipt, leaseRelease: settlement.release, providerResult });
    let existing;
    try { existing = readRuntimeInvocationRecord({ root: projectRoot, authorizationId: authorization.authorizationId, storage: originalFormat(authorization) }); }
    catch (error) { if (error.code !== "RUNTIME_INVOCATION_RESULT_NOT_FOUND") throw error; }
    if (existing) {
      if (existing.receipt.receiptHash !== receipt.receiptHash || existing.draft.draftHash !== draft.draftHash
        || hash(encode(existing.events)) !== hash(encode([...events].sort((a, b) => a.sequence - b.sequence)))) fail("Existing P3 result conflicts with frozen provider output.");
    } else {
      persistRuntimeInvocationRecord({ projectRoot, authorization, events, receipt, draft });
    }
    if (proposalMode(authorization) && receipt.status === "completed") {
      const record = readRuntimeInvocationRecord({ root: projectRoot, authorizationId: authorization.authorizationId, storage: originalFormat(authorization) });
      publishProviderProposal(directory, frozenProviderProposal({ projectRoot, authorization, binding, record }));
    }
    return readBoundedWorkerJob(input, inspection);
  });
}

export async function runBoundedWorkerJobOwner(bindingFile, { signal, onProcess = () => {} } = {}) {
  const initial = read(bindingFile);
  const { projectRoot, authorization } = identity(initial.projectRoot, initial.authorizationId);
  // Detached owners recreate the exact logical Session route from the verified
  // Project-bound authorization, never from a provider/session environment.
  return withSessionRoute(projectRoot, sessionIdOf(authorization), () => runRoutedOwner(bindingFile, { signal, onProcess }, { projectRoot, authorization }));
}

async function runRoutedOwner(bindingFile, { signal, onProcess }, { projectRoot, authorization }) {
  const directory = jobDirectory(resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false }), authorization);
  if (path.resolve(bindingFile) !== path.join(directory, "binding.json")) fail("Owner binding path differs.");
  const { binding } = verifiedBinding(directory, projectRoot, authorization);
  if (binding.codeDigest !== codeIdentity(binding.runnerFile, binding.hostModuleFile)) fail("Worker owner code changed after preparation.", "WORKER_JOB_CODE_DRIFT");
  if (Date.now() >= binding.deadlineUnixMs) fail("Worker deadline expired before execution.", "WORKER_JOB_DEADLINE_EXPIRED");
  current(projectRoot, authorization);
  const executionRoot = workspaceBoundary(authorization, projectRoot, binding.policy, binding.workspaceBinding || null, true);
  readBoundedWorkerDispatch({ root: projectRoot, authorizationId: authorization.authorizationId });
  if (proposalPolicy(binding.policy)) {
    verifyProposalPolicy(binding.policy);
    if (!proposalMode(authorization) || binding.runnerFile !== fs.realpathSync(codexProposalRunnerFile)
      || binding.hostModuleFile || binding.hostModuleDigest) fail("Fresh proposal worker requires the fixed concrete backend.", "WORKER_JOB_POLICY_UNAVAILABLE");
  } else if (binding.policy.kind === "CodexWorkerPolicyPlan") {
    verifyCodexWorkerPolicyPlan(binding.policy);
    if (binding.runnerFile !== fs.realpathSync(codexRunnerFile) || !binding.hostModuleFile) fail("Codex worker is missing its fixed runner or trusted Host reconnect.", "WORKER_JOB_POLICY_UNAVAILABLE");
    if (hash(regularBytes(binding.hostModuleFile, 1024 * 1024)) !== binding.hostModuleDigest) fail("Trusted Codex Host reconnect differs from its original binding.", "WORKER_JOB_CODE_DRIFT");
  } else if (binding.policy.kind !== "protocol-fixture" || binding.policy.actualProviderInvoked !== false || binding.hostModuleFile) fail("Worker job policy is unavailable.", "WORKER_JOB_POLICY_UNAVAILABLE");
  const runner = await import(pathToFileURL(binding.runnerFile).href);
  if (typeof runner.default !== "function") fail("Invalid Host worker runner.");
  let proposalSupervisor;
  if (proposalMode(authorization)) {
    proposalSupervisor = resolveVerifiedProcessSupervisor({ pluginRoot: path.dirname(binding.supervisorManifestPath), manifestFile: binding.supervisorManifestPath });
    if (proposalSupervisor.manifest.manifestHash !== binding.supervisorManifestDigest) fail("Proposal supervisor differs from the frozen owner binding.");
  }
  await runner.default({ root: projectRoot, executionRoot, authorization, policy: binding.policy,
    workspaceBinding: binding.workspaceBinding || null, hostModuleFile: binding.hostModuleFile || null,
    hostConnection: binding.hostConnection || null, signal, onProcess,
    ...(proposalSupervisor ? { supervisorSelection: proposalSupervisor } : {}) });
  let workspacePatchDigest;
  if (proposalMode(authorization)) {
    const record = readRuntimeInvocationRecord({ root: projectRoot, authorizationId: authorization.authorizationId, storage: originalFormat(authorization) });
    // Failed output remains failure evidence; it cannot become a patch candidate.
    if (record.receipt.status === "completed") {
      const frozenPatch = frozenProviderProposal({ projectRoot, authorization, binding, record });
      publishProviderProposal(directory, frozenPatch);
      workspacePatchDigest = hash(encode(frozenPatch));
    }
  } else if (authorization.workerInput.writeBasis) {
    const record = readRuntimeInvocationRecord({ root: projectRoot, authorizationId: authorization.authorizationId, storage: originalFormat(authorization) });
    const settlement = readRuntimeExecutionSettlement({ projectRoot, authorization });
    if (!settlement || settlement.release.lifecycleReceiptId !== record.receipt.receiptId || record.receipt.status !== "completed") fail("Worker patch collection requires its settled invocation result.");
    const candidate = collectWorkerWorkspacePatch({ binding: binding.workspaceBinding,
      sourceBasis: authorization.workerInput.sourceBasis, writeBasis: authorization.workerInput.writeBasis, storage: originalFormat(authorization) });
    const frozenPatch = { authorizationHash: authorization.authorizationHash, inputDigest: authorization.executionInput.digest,
      workspaceBindingDigest: binding.workspaceBinding.bindingDigest, lifecycleReceiptId: record.receipt.receiptId, candidate };
    publish(path.join(directory, "workspace-patch.json"), frozenPatch);
    workspacePatchDigest = hash(encode(frozenPatch));
  }
  return { authorizationId: authorization.authorizationId, runnerReturned: true,
    ...(workspacePatchDigest ? { workspacePatchDigest,
      ...(proposalMode(authorization) ? { workspacePatchOrigin: "provider-patch-proposal" } : {}) } : {}), recoveryAuthority: false };
}
