import { publicToolName } from "./lode-artifact-composition.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectProject } from "./lode-core.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { buildRuntimeVersionEvidence } from "./runtime-machine-execution.mjs";
import { resolveReadOnlyRuntimeExecutableTarget } from "./runtime-machine-discovery.mjs";
import { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } from "./runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, readRuntimeInvocationAuthorization, reconcileWorkerMember } from "./runtime-invocation-lifecycle.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { captureWorkerSourceBasis } from "./worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "./worker-patch-basis.mjs";
import { prepareWorkerWorkspace, verifyWorkerWorkspace } from "./worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary } from "./worker-patch-proposal.mjs";
import { buildCodexFreshProposalPolicyPlan, verifyCodexFreshProposalPolicyPlan, assertCodexFreshProposalPolicy } from "./runtime-codex-proposal-policy.mjs";
import { buildCodexNativePrefixPolicyPlan, verifyCodexNativePrefixPolicyPlan, assertCodexNativePrefixPolicy } from "./runtime-codex-prefix-policy.mjs";
import { inspectCodexFreshProposalHostInventory } from "./runtime-codex-app-server-transport.mjs";
import { resolveVerifiedProcessSupervisor } from "./runtime-process-supervisor.mjs";
import { createBoundedWorkerJobHost, startBoundedWorkerJob } from "./bounded-worker-job.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const fail = (message, code = "LOCAL_WORKER_PREPARATION_CONFLICT") => { throw Object.assign(new Error(message), { code }); };
const fixtureBackends = new WeakMap();

function regular(file, limit = 8 * 1024 * 1024, links = [1]) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !links.includes(stat.nlink) || stat.size > limit || fs.realpathSync(file) !== path.resolve(file)) fail("Unsafe local Host record.");
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (bytes.length !== stat.size || stat.ino !== after.ino || stat.dev !== after.dev || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail("Local Host record changed during read.");
  return bytes;
}
function directory(parent, name, create) {
  const result = path.join(parent, name);
  if (create) { try { fs.mkdirSync(result, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
  if (fs.existsSync(result) && (!fs.lstatSync(result).isDirectory() || fs.lstatSync(result).isSymbolicLink() || fs.realpathSync(result) !== result)) fail("Local Host directory traverses a link.");
  return result;
}
function location(root, projectId, sessionId, runId, taskKey, create = false, storage) {
  let parent = resolveRuntimeOperationalStateRoot({ projectRoot: root, storage, create });
  parent = directory(parent, "worker-preparations", create);
  parent = directory(parent, projectId, create);
  return { parent, file: path.join(parent, `${digest({ projectId, sessionId, runId, taskKey })}.json`) };
}
function basisFile(destination, sourceBasis, proposalBasis) {
  return destination.file.replace(/\.json$/, `--${digest({ sourceBasis, proposalBasis })}.json`);
}
function sameBasis(record, sourceBasis, proposalBasis) {
  return digest({ sourceBasis: record.sourceBasis, proposalBasis: record.proposalBasis }) === digest({ sourceBasis, proposalBasis });
}
function sameBoundedTask(previous, next) {
  // HEAD may explicitly reselect read evidence for the same task. This does
  // not change its meaning, model, proposal targets, limits or instruction scope.
  const { sourcePaths: previousSelection, ...previousTask } = previous;
  const { sourcePaths: nextSelection, ...nextTask } = next;
  return digest(previousTask) === digest(nextTask);
}
function normalize(input) {
  const fields = new Set(["task", "taskKey", "role", "outcome", "selectedContext", "sourcePaths", "proposalPaths", "model", "runtime", "timeoutMs", "instructionScope", "contextMode"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) fail("Worker preparation accepts task/member/context/source/proposal fields, not Host code, paths, environment or policy assertions.");
  if (typeof input.task !== "string" || !input.task.trim() || typeof input.model !== "string" || !/^gpt-[A-Za-z0-9._-]+$/.test(input.model)) fail("HEAD must supply the task and exact Codex model.");
  if (input.contextMode !== undefined && !["fresh", "native-prefix"].includes(input.contextMode)) fail("Unsupported worker context mode.");
  if (input.contextMode === "native-prefix" && (typeof input.selectedContext !== "string" || !input.selectedContext.trim()
    || Buffer.byteLength(input.selectedContext) > 16 * 1024)) fail("Native-prefix preparation needs bounded selected context for its controlled seed, not a parent thread ID.");
  const request = { ...(input.contextMode === "native-prefix" ? { contextMode: "native-prefix" } : {}),
    task: input.task, taskKey: input.taskKey || `member-${digest({ task: input.task, role: input.role || "coder" }).slice(0, 24)}`,
    role: input.role || "coder", outcome: input.outcome || input.task, selectedContext: input.selectedContext ?? "",
    sourcePaths: input.sourcePaths ?? [], proposalPaths: input.proposalPaths ?? [], model: input.model, runtime: input.runtime ?? "codex",
    timeoutMs: input.timeoutMs ?? 60000, instructionScope: input.instructionScope ?? "selected-only" };
  if (request.runtime !== "codex") fail("The built-in fresh proposal backend currently supports Codex only; no provider substitution was made.", "LOCAL_WORKER_BACKEND_UNAVAILABLE");
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(request.taskKey) || !["coder", "developer", "reviewer"].includes(request.role)
    || typeof request.outcome !== "string" || !request.outcome.trim() || typeof request.selectedContext !== "string"
    || !Array.isArray(request.sourcePaths) || !Array.isArray(request.proposalPaths)
    || request.sourcePaths.some(value => typeof value !== "string") || request.proposalPaths.some(value => typeof value !== "string")
    || !["selected-only", "host-global"].includes(request.instructionScope)
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 3600000
    || Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) fail("Invalid bounded worker preparation input.");
  request.sourcePaths = [...new Set(request.sourcePaths)].sort();
  request.proposalPaths = [...new Set(request.proposalPaths)].sort();
  return request;
}
function selectedInstructions(codexHome, scope) {
  if (scope === "selected-only") return {};
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const file = path.join(codexHome, name);
    try { const bytes = regular(file, 128 * 1024); if (bytes.toString("utf8").trim()) return { [name]: hash(bytes) }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return {};
}
function readPrepared(file, root, projectId, sessionId, runId, request = null) {
  // Short local publication/recovery transaction only; never held across
  // discovery, a provider call, a worker lease, or a user's decision.
  return withProjectMutation({ root, scope: "worker-host-preparation" }, () => readPreparedUnlocked(file, root, projectId, sessionId, runId, request));
}
function readPreparedUnlocked(file, root, projectId, sessionId, runId, request = null) {
  // An interrupted link publication is the only accepted two-link state.
  // Validate the payload and exact owned staging path before removing anything.
  const bytes = regular(file, 8 * 1024 * 1024, [1, 2]);
  const record = JSON.parse(bytes);
  const { recordDigest, ...payload } = record;
  if (recordDigest !== digest(payload) || record.kind !== "LocalWorkerPreparation" || record.version !== "0.1.0"
    || record.projectId !== projectId || record.sessionId !== sessionId || record.runId !== runId || record.root !== root
    || request && digest(record.request) !== digest(request) || record.recoveryAuthority !== false) fail("Prepared worker differs from this exact task/member/lineage.");
  if (digest(normalize(record.request)) !== digest(record.request)
    || digest(record.request.sourcePaths) !== digest(record.sourceBasis.map(entry => entry.path))) fail("Preparation read selection does not match its exact source basis.");
  if (record.request.contextMode === "native-prefix") {
    verifyCodexNativePrefixPolicyPlan(record.policy);
    if (record.policy.seed.text !== record.request.selectedContext) fail("Prepared native prefix differs from the selected input.");
  } else verifyCodexFreshProposalPolicyPlan(record.policy);
  const destination = location(root, projectId, sessionId, runId, record.request.taskKey, false, originalFormat(record.projectBinding));
  if (file !== destination.file && file !== basisFile(destination, record.sourceBasis, record.proposalBasis)) fail("Preparation file does not match its exact member/basis.");
  if (fs.lstatSync(file).nlink === 2) {
    const stage = path.dirname(record.workspaceBinding.executionRoot);
    if (path.dirname(stage) !== destination.parent || !/^selected-[A-Za-z0-9_-]+$/.test(path.basename(stage))
      || path.basename(record.workspaceBinding.executionRoot) !== "workspace") fail("Interrupted preparation has no exact owned pending path.");
    directory(destination.parent, path.basename(stage), false);
    const pending = path.join(stage, "preparation.json");
    const pendingBytes = regular(pending, 8 * 1024 * 1024, [2]);
    const publishedStat = fs.lstatSync(file), pendingStat = fs.lstatSync(pending);
    if (!bytes.equals(pendingBytes) || publishedStat.nlink !== 2 || pendingStat.nlink !== 2
      || publishedStat.dev !== pendingStat.dev || publishedStat.ino !== pendingStat.ino
      || !regular(file, 8 * 1024 * 1024, [2]).equals(bytes)) fail("Interrupted preparation does not own this pending link.");
    fs.unlinkSync(pending);
    if (!regular(file).equals(bytes)) fail("Preparation changed during publication recovery.");
  }
  return record;
}

// Fixed synthetic seam for component tests/embedding; never accepted from wire
// arguments or environment and never produces actual-provider evidence.
export function createLocalWorkerProtocolFixtureBackend({ codexHome, environment, spawnImplementation } = {}) {
  if (typeof spawnImplementation !== "function") fail("Expected a model-free schema observer.");
  const capability = Object.freeze(Object.create(null));
  fixtureBackends.set(capability, { codexHome: fs.realpathSync(codexHome), environment, spawnImplementation });
  return capability;
}

export async function prepareLocalBoundedWorker(input, options = {}) {
  const request = normalize(input);
  try { return await prepareLocalBoundedWorkerInternal(request, options); }
  catch (error) {
    // A known input-scope limitation of this optional backend, not permission
    // to discard global instructions, broaden input, or block ordinary work.
    // Unknown policy/integrity/discovery failures remain errors.
    if (request.instructionScope !== "selected-only" || error.code !== "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT"
      || error.reason !== "unselected-global-instructions") throw error;
    return { status: "unavailable_for_selected_scope", code: error.code, reason: error.reason,
      taskKey: request.taskKey, runtime: request.runtime, model: request.model,
      contextMode: request.contextMode || "fresh", instructionScope: request.instructionScope,
      modelCallAttempted: false, accountInspected: false, workersStarted: 0,
      guidance: {
        affectedOperation: "selected-only-managed-worker-preparation", ordinaryWorkBlocked: false, userActionRequired: false,
        nextStep: "Continue direct HEAD work or ordinary Host delegation within its existing authorized scope. This managed proposal mode cannot exclude the current CLI global instructions using the audited provider recipe.",
        scopeChange: "Do not switch instruction scope, copy authentication, change global settings, or retry automatically. Include global instructions only if their exact transmission is already covered by user authorization; otherwise obtain that specific authorization before a different preparation.",
        alternativeCapabilityVerified: false, automaticRetry: false, persisted: false,
      }, grantsPermission: false, recoveryAuthority: false };
  }
}

async function prepareLocalBoundedWorkerInternal(input, { root = ".", supervisorSelection = null, signal, onProcess = () => {}, protocolFixtureBackend = null } = {}) {
  const request = normalize(input), inspected = inspectProject(root), projectRoot = fs.realpathSync(root);
  if (inspected.status !== "ready") fail("Initialize or resume this HEAD Project before preparing its worker.", "PROJECT_NOT_READY");
  const { projectId } = inspected.project, sessionId = inspected.state.sessionId, runId = inspected.state.activeRunId || null;
  const memberDestination = location(projectRoot, projectId, sessionId, runId, request.taskKey, true, inspected.storage);
  let destination = memberDestination;
  const sourceBasis = captureWorkerSourceBasis({ root: projectRoot, paths: request.sourcePaths, maxBytes: 1024 * 1024, storage: inspected.storage });
  const proposalBasis = captureWorkerWriteBasis({ root: projectRoot, paths: request.proposalPaths, maxBytes: 1024 * 1024, storage: inspected.storage });
  let record;
  if (fs.existsSync(memberDestination.file)) {
    record = readPrepared(memberDestination.file, projectRoot, projectId, sessionId, runId);
    if (!sameBoundedTask(record.request, request)) fail("Prepared worker differs from this bounded task; only explicit read-evidence reselection is allowed.");
    if (!sameBasis(record, sourceBasis, proposalBasis)) {
      destination = { ...memberDestination, file: basisFile(memberDestination, sourceBasis, proposalBasis) };
      record = fs.existsSync(destination.file) ? readPrepared(destination.file, projectRoot, projectId, sessionId, runId, request) : null;
    }
  }
  if (!record) {
    const fixture = protocolFixtureBackend === null ? null : fixtureBackends.get(protocolFixtureBackend);
    if (protocolFixtureBackend !== null && !fixture) fail("Unrecognized synthetic Host capability.");
    const environment = fixture?.environment || process.env;
    const target = fixture ? { executablePath: fs.realpathSync(process.execPath) }
      : resolveReadOnlyRuntimeExecutableTarget({ runtime: "codex", environment });
    if (!target.executablePath) fail("Codex executable was not discovered by the local Host.", "LOCAL_WORKER_BACKEND_UNAVAILABLE");
    const codexHome = fixture?.codexHome || fs.realpathSync(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const initialPolicy = buildCodexFreshProposalPolicyPlan({ executablePath: target.executablePath, codexHome,
      model: `openai/${request.model}`, wireModel: request.model, evidenceMode: fixture ? "protocol-fixture" : "actual-provider",
      approvedGlobalInstructionDigests: selectedInstructions(codexHome, request.instructionScope) });
    const selection = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
    const stage = fs.mkdtempSync(path.join(destination.parent, "selected-"));
    const workspaceBinding = prepareWorkerWorkspace({ projectRoot, workspaceRoot: path.join(stage, "workspace"), sourceBasis, maxBytes: 1024 * 1024, storage: inspected.storage });
    let policy = initialPolicy;
    if (!fixture) {
      const inventory = await inspectCodexFreshProposalHostInventory({ policy, executionRoot: workspaceBinding.executionRoot,
        controlFile: path.join(stage, "discovery-1.jsonl"), supervisorSelection: selection, signal, onProcess });
      policy = buildCodexFreshProposalPolicyPlan({ ...initialPolicy, ...inventory, approvedGlobalInstructionDigests: selectedInstructions(codexHome, request.instructionScope) });
      await inspectCodexFreshProposalHostInventory({ policy, executionRoot: workspaceBinding.executionRoot,
        controlFile: path.join(stage, "discovery-2.jsonl"), supervisorSelection: selection, signal, onProcess, verifyInventory: true });
    }
    let observerFailure;
    const observeSpawn = fixture?.spawnImplementation || ((command, args, options) => {
      onProcess({ type: "planned", phase: "runtime-capability", command, args, cwd: options.cwd, parentPid: process.pid, ports: [] });
      const child = spawn(command, args, options);
      child.once("close", exitCode => { try { onProcess({ type: "exit", phase: "runtime-capability", pid: child.pid, exitCode, ports: [] }); } catch (error) { observerFailure ||= error; } });
      try { onProcess({ type: "spawn", phase: "runtime-capability", command, pid: child.pid, parentPid: process.pid, cwd: options.cwd, ports: [] }); }
      catch (error) { observerFailure ||= error; child.kill(); }
      return child;
    });
    const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: observeSpawn });
    if (observerFailure) throw observerFailure;
    const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: observeSpawn });
    if (observerFailure) throw observerFailure;
    const projectBinding = buildRuntimeProjectBinding({ projectId, headSessionId: sessionId, projectRoot,
      projectStatus: inspected.status, versionEvidence, protocolEvidence, storage: inspected.storage });
    // A controlled seed is a different, explicit two-turn contract, never an
    // arbitrary parent fork or a proof of the stronger code-worker backend.
    if (request.contextMode === "native-prefix") policy = buildCodexNativePrefixPolicyPlan({ freshPolicy: policy, seedText: request.selectedContext });
    // Validate the complete Core request before publishing a reusable Host plan.
    const payload = { kind: "LocalWorkerPreparation", version: "0.1.0", root: projectRoot, projectId, sessionId, runId,
      request, policy, workspaceBinding, sourceBasis, proposalBasis, protocolEvidence, projectBinding, recoveryAuthority: false };
    buildRuntimeInvocationAuthorization({ ...authorizationInput(payload), persist: false });
    const pending = path.join(stage, "preparation.json");
    const pendingBytes = Buffer.from(JSON.stringify({ ...payload, recordDigest: digest(payload) }));
    fs.writeFileSync(pending, pendingBytes, { flag: "wx", mode: 0o600 });
    record = withProjectMutation({ root: projectRoot, scope: "worker-host-preparation" }, () => {
      try { fs.linkSync(pending, destination.file); } catch (error) { if (error.code !== "EEXIST") throw error; }
      fs.unlinkSync(pending);
      return readPreparedUnlocked(destination.file, projectRoot, projectId, sessionId, runId, request);
    });
  }
  if (!sameBasis(record, sourceBasis, proposalBasis)) fail("Concurrent preparation selected a different source basis; prepare the same member again.");
  if (signal?.aborted) fail("Worker preparation cancelled.", "LOCAL_WORKER_PREPARATION_CANCELLED");
  verifyWorkerWorkspace({ binding: record.workspaceBinding, sourceBasis: record.sourceBasis, storage: originalFormat(record.projectBinding) });
  const built = buildRuntimeInvocationAuthorization(authorizationInput(record));
  if (built.authorization.workerInput.executionBoundary.policyDigest !== hash(JSON.stringify(record.policy))) fail("Prepared policy changed.");
  return { status: built.status === "existing" ? "reused" : "prepared", taskKey: request.taskKey, role: request.role,
    authorizationId: built.authorization.authorizationId, model: request.model, runtime: request.runtime,
    sourceCount: record.sourceBasis.length, proposalTargetCount: record.proposalBasis.length,
    instructionScope: request.instructionScope, evidenceMode: record.policy.evidenceMode,
    contextMode: request.contextMode || "fresh",
    executionPlan: { maximumModelTurns: request.contextMode === "native-prefix" ? 2 : 1,
      durableSeedHistory: request.contextMode === "native-prefix", inheritsParentThread: false,
      automaticFileApplication: false, grantsPermission: false },
    modelCallAttempted: false, accountInspected: false, workersStarted: 0, recoveryAuthority: false,
    nextAction: { tool: publicToolName("head_bounded_worker_start"), task_key: request.taskKey } };
}
function authorizationInput(record) {
  const { request, root, policy, workspaceBinding, sourceBasis, proposalBasis, protocolEvidence, projectBinding } = record;
  const current = inspectProject(root);
  if (current.status !== "ready" || current.project.projectId !== record.projectId || current.state.sessionId !== record.sessionId
    || (current.state.activeRunId || null) !== record.runId) fail("Session or Run changed during worker preparation; no new authority may use the old Host selection.");
  const boundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis, storage: current.storage });
  return { root, runtime: "codex", runtimeSelection: { model: policy.model }, workspaceMode: "read-only",
    scope: record.runId ? { kind: "run" } : { kind: "session", request: request.task }, protocolEvidence, projectBinding,
    limits: { timeoutMs: request.timeoutMs }, worker: { taskKey: request.taskKey, role: request.role, outcome: request.outcome,
      selectedContext: request.selectedContext, sourcePaths: request.sourcePaths, proposalPaths: request.proposalPaths, executionBoundary: boundary } };
}

export async function startLocalBoundedWorker({ root = ".", authorizationId, taskKey, role } = {}, options = {}) {
  if (authorizationId && taskKey) fail("Select a worker by task key or exact authorization, not both.");
  const projectRoot = fs.realpathSync(root);
  const authorization = authorizationId ? readRuntimeInvocationAuthorization({ root: projectRoot, authorizationId }).authorization
    : reconcileWorkerMember({ root: projectRoot, taskKey }).authorization;
  if (!authorization.workerInput) fail("This authorization has no retained worker input.", "WORKER_JOB_INPUT_REQUIRED");
  role ??= authorization.workerInput?.role;
  // Repeating a start is a historical job read, not new execution. Preserve
  // that behavior after Run/Session drift or loss of preparation-only state.
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot, storage: originalFormat(authorization), create: false });
  if (fs.existsSync(path.join(operational, "worker-jobs", authorization.projectId, authorization.authorizationId, "binding.json"))) {
    return startBoundedWorkerJob({ root: projectRoot, authorizationId: authorization.authorizationId, role }, options);
  }
  if (options.host) return startBoundedWorkerJob({ root: projectRoot, authorizationId: authorization.authorizationId, role }, options);
  const destination = location(projectRoot, authorization.projectId, sessionIdOf(authorization), authorization.scope.runId, authorization.workerInput.taskKey, false, originalFormat(authorization));
  if (!fs.existsSync(destination.file)) fail("This member has no retained built-in Host preparation. No job was started. Inspect its existing authorization and effects before deciding how to settle this managed task; ordinary independent work remains available.", "LOCAL_WORKER_PREPARATION_REQUIRED");
  let record = readPrepared(destination.file, projectRoot, authorization.projectId, sessionIdOf(authorization), authorization.scope.runId);
  if (!sameBasis(record, authorization.workerInput.sourceBasis, authorization.workerInput.proposalBasis)) {
    record = readPrepared(basisFile(destination, authorization.workerInput.sourceBasis, authorization.workerInput.proposalBasis),
      projectRoot, authorization.projectId, sessionIdOf(authorization), authorization.scope.runId,
      { ...record.request, sourcePaths: authorization.workerInput.sourceBasis.map(entry => entry.path) });
  }
  if (authorization.workerInput.executionBoundary?.workspaceBindingDigest !== record.workspaceBinding.bindingDigest
    || authorization.workerInput.executionBoundary?.policyDigest !== hash(JSON.stringify(record.policy))) fail("Worker authorization does not match its prepared Host.");
  (record.request.contextMode === "native-prefix" ? assertCodexNativePrefixPolicy : assertCodexFreshProposalPolicy)({
    policy: record.policy, authorization, workspaceBinding: record.workspaceBinding, root: projectRoot });
  const host = createBoundedWorkerJobHost({ policy: record.policy, workspaceBinding: record.workspaceBinding });
  return startBoundedWorkerJob({ root: projectRoot, authorizationId: authorization.authorizationId, role }, { ...options, host });
}
