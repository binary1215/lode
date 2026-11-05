import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBoundedWorkerJobHost } from "./bounded-worker-job.mjs";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { verifyWorkerWorkspace } from "./worker-workspace.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { verifyRuntimeProjectBinding, verifyRuntimeProtocolEvidence } from "./runtime-protocol-evidence.mjs";
import { bindCodexWorkerPolicyCapability, createCodexWorkerPolicyHost, verifyCodexWorkerPolicyPlan } from "./runtime-codex-worker-policy.mjs";
import { createCodexNativeForkHost, CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE } from "./runtime-codex-native-fork.mjs";
import { createCodexAppServerProtocolFixtureTransport } from "./runtime-codex-app-server-transport.mjs";
import { inspectCurrentCodexNativeForkCompatibility } from "./runtime-codex-fork-compatibility.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
const fail = (code = "CODEX_WORKER_HOST_CONNECTION_MISMATCH") => { throw Object.assign(new Error(code), { code }); };
const moduleFile = fileURLToPath(import.meta.url);

// Operational reconnect data is embedded in the existing P5 job binding, not
// in Core/P2 or a new permission artifact. No callback, executable override,
// credential, environment or serialized proof can be supplied by this record.
export function buildCodexNativeForkHostConnection({ authorization, policy, workspaceBinding,
  protocolEvidence, projectBinding, supervisorSelection, source, rebind, scenario = "native-composition" } = {}) {
  const fixed = verifyCodexWorkerPolicyPlan(policy);
  if (fixed.mode !== "native-fork") fail();
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  verifyRuntimeProtocolEvidence(protocolEvidence);
  verifyRuntimeProjectBinding(projectBinding);
  if (!source || Object.keys(source).sort().join() !== "lastTurnId,prefixDigest,threadId"
    || source.prefixDigest !== fixed.retainedContextDigest || rebind?.modelProvider !== fixed.wireModelProvider
    || !["native-composition", "native-composition-lost-fork", "native-composition-stale", "native-composition-policy-drift"].includes(scenario)) fail();
  const payload = { kind: "CodexNativeForkHostConnection", protocolVersion: "0.1.0",
    authorizationHash: verified.authorizationHash, policyDigest: hash(json(fixed)), inputDigest: verified.executionInput.digest,
    workspaceBindingDigest: workspaceBinding.bindingDigest, evidenceMode: fixed.evidenceMode,
    protocolEvidence, projectBinding, supervisorManifestPath: supervisorSelection.manifestPath,
    supervisorManifestDigest: supervisorSelection.manifest.manifestHash, source, rebind, scenario,
    recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false };
  if (Buffer.byteLength(json(payload)) > 1024 * 1024) fail();
  return JSON.parse(json({ ...payload, connectionDigest: hash(json(payload)) }));
}

function verifyConnection({ root, executionRoot, authorization, policy, workspaceBinding, hostConnection }) {
  const fixed = verifyCodexWorkerPolicyPlan(policy);
  if (fixed.mode !== "native-fork") fail();
  // Installed schemas, profile echoes and a prompt do not implement selected
  // reads/tools or inherited-instruction isolation. There is no actual backend
  // yet. Fail before filesystem writes, lease consumption, RPC or model calls.
  if (fixed.evidenceMode === "actual-provider") throw Object.assign(new Error(CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE), {
    code: CODEX_NATIVE_FORK_ACTUAL_UNAVAILABLE, compatibility: inspectCurrentCodexNativeForkCompatibility() });
  const c = hostConnection;
  if (!c || c.kind !== "CodexNativeForkHostConnection" || c.protocolVersion !== "0.1.0") fail();
  const { connectionDigest, ...payload } = c;
  if (hash(json(payload)) !== connectionDigest || c.evidenceMode !== fixed.evidenceMode
    || c.authorizationHash !== authorization.authorizationHash || c.inputDigest !== authorization.executionInput.digest
    || c.policyDigest !== hash(json(fixed)) || c.workspaceBindingDigest !== workspaceBinding?.bindingDigest
    || root !== workspaceBinding.canonicalRoot || executionRoot !== workspaceBinding.executionRoot
    || c.source.prefixDigest !== fixed.retainedContextDigest || c.rebind.modelProvider !== fixed.wireModelProvider
    || fixed.workspaceMode !== "read-only" || fixed.executableIdentity.pathDigest !== hash(fs.realpathSync(process.execPath))
    || fixed.executableIdentity.contentDigest !== hash(fs.readFileSync(process.execPath))) fail();
  const prepared = prepareRuntimeInvocationExecution({ root, authorization });
  verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis: authorization.workerInput.sourceBasis, storage: originalFormat(authorization) });
  const protocol = verifyRuntimeProtocolEvidence(c.protocolEvidence);
  const project = verifyRuntimeProjectBinding(c.projectBinding);
  if (protocol.evidenceId !== authorization.runtimeProtocolEvidenceId || project.bindingId !== authorization.runtimeProjectBindingId
    || project.protocolEvidenceId !== protocol.evidenceId || project.projectId !== authorization.projectId
    || sessionIdOf(project) !== sessionIdOf(authorization) || project.projectRootDigest !== hash(prepared.projectRoot)) fail();
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot: path.dirname(c.supervisorManifestPath), manifestFile: c.supervisorManifestPath });
  if (selection.manifest.manifestHash !== c.supervisorManifestDigest) fail();
  const rebuilt = buildCodexNativeForkHostConnection({ authorization, policy: fixed, workspaceBinding,
    protocolEvidence: protocol, projectBinding: project, supervisorSelection: selection, source: c.source, rebind: c.rebind, scenario: c.scenario });
  if (json(rebuilt) !== json(c)) fail();
  return { fixed, prepared, selection, target: { executablePath: fs.realpathSync(process.execPath),
    observation: protocol.observations.find(value => value.runtime === "codex")?.executable } };
}

// The fixed runner calls this again inside its owned process. Parent capabilities
// are never serialized. A reconnect is inert until the existing lease invokes
// the opaque native transport factory; an uncertain fork cannot be replayed.
export async function connectCodexWorkerHost(options = {}) {
  const { root, executionRoot, authorization, workspaceBinding, signal, onProcess = () => {} } = options;
  const hostConnection = JSON.parse(json(options.hostConnection ?? null));
  const binding = { root, executionRoot, authorization, policy: options.policy, workspaceBinding, hostConnection };
  const { fixed, selection, target } = verifyConnection(binding);
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot: root, storage: originalFormat(authorization), create: false });
  const directory = path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId);
  let journalFd = null;
  let transport;
  let closed = false;
  let closePromise = null;
  const record = event => {
    // This callback first runs inside the consumed lease. Keep one bounded
    // transcript file, not an artifact per notification or status read.
    if (journalFd === null) {
      let current = operational;
      for (const segment of ["worker-jobs", authorization.projectId, authorization.authorizationId]) {
        current = path.join(current, segment);
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail();
      }
      journalFd = fs.openSync(path.join(directory, "native-host-transcript.jsonl"), "wx", 0o600);
    }
    fs.writeSync(journalFd, `${json(event)}\n`);
    fs.fsyncSync(journalFd);
    const type = { "process-planned": "planned", "process-started": "spawn", "process-closed": "exit" }[event.event];
    if (type) onProcess({ ...event, type });
  };
  // This concrete backend launches only the fixed model-free protocol fixture.
  // No arbitrary transport or caller proof callback crosses the product API.
  transport = createCodexAppServerProtocolFixtureTransport({ nativeOwnership: true,
    executionRoot, controlFile: path.join(directory, "native-host-control.jsonl"), supervisorSelection: selection,
    sourceThreadId: hostConnection.source.threadId, authorizationHash: authorization.authorizationHash,
    policyDigest: hostConnection.policyDigest, inputDigest: authorization.executionInput.digest,
    scenario: hostConnection.scenario, terminationGraceMs: authorization.limits.terminationGraceMs,
    providerEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "temp", "tmp"].includes(key.toLowerCase()))),
    limits: { maxFrameBytes: authorization.limits.maxStdoutBytes, maxOutputBytes: authorization.limits.maxStdoutBytes,
      maxStderrBytes: authorization.limits.maxStderrBytes, maxRequests: 32, maxNotifications: 64 }, recordOperationalEvidence: record });
  const policyHost = createCodexWorkerPolicyHost({ evidenceMode: "protocol-fixture", withVerifiedPolicy: async request => {
    if (signal?.aborted || request.evidenceMode !== "protocol-fixture"
      || request.authorization.authorizationHash !== authorization.authorizationHash) fail();
    verifyConnection(binding);
    return request.commit();
  } });
  const nativeForkHost = createCodexNativeForkHost({ evidenceMode: "protocol-fixture",
    source: hostConnection.source, rebind: hostConnection.rebind, authorizationHash: authorization.authorizationHash,
    policyDigest: hostConnection.policyDigest, inputDigest: authorization.executionInput.digest,
    request: transport.request, nextNotification: transport.nextNotification, cleanup: transport.cleanup,
    ownedTransport: transport.ownedTransport, recordOperationalEvidence: record,
    withVerifiedFork: async request => {
      if (closed || request.signal?.aborted || request.authorizationHash !== authorization.authorizationHash
        || request.policyDigest !== hostConnection.policyDigest || request.inputDigest !== authorization.executionInput.digest
        || json(request.source) !== json(hostConnection.source)) fail();
      verifyConnection(binding);
      // Fixture evidence only. Actual effective inherited-policy enforcement is
      // deliberately not inferred from this handshake or child profile echoes.
      return request.commit();
    } });
  return { policyHost, nativeForkHost, execution: { protocolEvidence: hostConnection.protocolEvidence,
    projectBinding: hostConnection.projectBinding, supervisorSelection: selection, targetResolver: () => target },
    inspect: () => transport.inspect(), close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try { await transport.close(); } finally { if (journalFd !== null) { fs.closeSync(journalFd); journalFd = null; } }
      })();
      closePromise.catch(() => {});
      return closePromise;
    } };
}

export async function createCodexNativeForkJobHost(options = {}) {
  const fixed = { ...options, hostConnection: JSON.parse(json(options.hostConnection ?? null)) };
  const connection = await connectCodexWorkerHost(fixed);
  try {
    const capability = bindCodexWorkerPolicyCapability({ host: connection.policyHost, policy: options.policy,
      authorization: options.authorization, workspaceBinding: options.workspaceBinding, root: options.root,
      target: connection.execution.targetResolver() });
    // The disconnected parent's policy verifier remains usable only for the
    // prelaunch check; transport execution is reconnected in the owned runner.
    return createBoundedWorkerJobHost({ policy: options.policy, workspaceBinding: options.workspaceBinding,
      codexPolicyCapability: capability, hostModuleFile: moduleFile, hostConnection: fixed.hostConnection });
  } finally { await connection.close(); }
}
