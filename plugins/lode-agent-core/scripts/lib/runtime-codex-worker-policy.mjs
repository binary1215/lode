import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { verifyWorkerWorkspace } from "./worker-workspace.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
const fail = (message, code = "WORKER_JOB_POLICY_UNAVAILABLE") => { throw Object.assign(new Error(message), { code }); };
const hosts = new WeakMap();
const capabilities = new WeakMap();
const clone = value => JSON.parse(json(value));
function freeze(value) {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}

// These are obligations, not Codex flags or assertions of enforcement. The
// installed 0.153.4 schema has no universal tool switch or readableRoots field.
export const CODEX_WORKER_REQUIRED_ENFORCEMENT = Object.freeze([
  "effective-os-sandbox", "selected-input-reads", "exact-owned-path-writes",
  "outside-root-denials", "credential-store-denials", "provider-network-only",
  "effective-tool-scope", "effective-instruction-scope", "owned-process-tree",
]);

export function buildCodexWorkerPolicyPlan({ executablePath, executableDigest, model, wireModel, wireModelProvider,
  workspaceMode = "read-only", mode = "selected-exec", evidenceMode = "actual-provider",
  retainedContextDigest = null } = {}) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)
    || !/^[a-f0-9]{64}$/.test(executableDigest || "") || typeof model !== "string" || !model.trim()
    || model !== model.trim() || /[\x00-\x1f]/u.test(model)
    || typeof wireModel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(wireModel) || wireModel.includes("..")
    || typeof wireModelProvider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(wireModelProvider)
    || model !== `${wireModelProvider}/${wireModel}`
    || !["read-only", "workspace-write"].includes(workspaceMode)
    || !["selected-exec", "native-fork"].includes(mode)
    || mode === "native-fork" && retainedContextDigest === null
    || !["actual-provider", "protocol-fixture"].includes(evidenceMode)
    || retainedContextDigest !== null && !/^[a-f0-9]{64}$/.test(retainedContextDigest)) fail("Invalid Codex worker policy plan.", "INVALID_CODEX_WORKER_POLICY");
  return freeze({ kind: "CodexWorkerPolicyPlan", protocolVersion: "0.2.0", runtime: "codex", mode,
    evidenceMode,
    executableIdentity: { pathDigest: hash(path.resolve(executablePath)), contentDigest: executableDigest },
    // Explicit pre-authorization mapping, confirmed by the trusted Host. Core's
    // provider/model identifier is not necessarily the provider's wire model.
    // Never guess by stripping a prefix or reinterpret an older authorization.
    model, wireModel, wireModelProvider, workspaceMode, retainedContextDigest,
    requiredEnforcement: [...CODEX_WORKER_REQUIRED_ENFORCEMENT],
    // The actor boundary is part of the preauthorization digest, not a later
    // relaxation of 0.1 plans. Trusted substrate is not an automatic exception:
    // an actual Host must verify its exact constraints and keep it inaccessible
    // as an alternate model/tool route to task data or provider credentials.
    policyScope: {
      taskData: "model-visible-task-data",
      effects: "model-callable-tools-and-their-effects",
      instructions: "additional-configured-or-inherited-instructions",
      providerBaselineInstructions: "provider-owned-not-a-zero-semantic-influence-claim",
      trustedSubstrate: {
        actor: "trusted-p5-host-and-provider-runtime",
        purposes: ["os-runtime", "provider-runtime", "provider-authentication"],
        automaticExemptions: false, exactHostVerifiedConstraintsRequired: true,
        mayExposeUnselectedTaskData: false, mayExposeProviderCredentialsToModelOrTools: false,
      },
    },
    invocationConstraints: { context: "exact-authorized-input-and-selected-sources", reads: "selected-model-visible-task-data-only",
      writes: workspaceMode === "read-only" ? "no-model-callable-writes" : "exact-owned-model-callable-writes-only",
      network: "trusted-provider-transport-only-no-model-callable-network",
      instructions: "authorized-additional-configured-or-inherited-instructions-only", tools: "exact-host-verified-model-callable-scope",
      // These two options are grounded in installed exec help. App-server
      // explicitly rejects --ignore-user-config; never forward them to RPC.
      ignoreUserConfig: mode === "selected-exec", ignoreRules: mode === "selected-exec" },
    enforcementVerified: false, instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false });
}

export function verifyCodexWorkerPolicyPlan(policy) {
  if (!policy || policy.kind !== "CodexWorkerPolicyPlan" || policy.protocolVersion !== "0.2.0"
    || !/^[a-f0-9]{64}$/.test(policy.executableIdentity?.pathDigest || "")) fail("Invalid Codex worker policy plan.", "INVALID_CODEX_WORKER_POLICY");
  const rebuilt = buildCodexWorkerPolicyPlan({ executablePath: path.resolve("codex-policy-identity-placeholder"),
    executableDigest: policy.executableIdentity.contentDigest, model: policy.model,
    wireModel: policy.wireModel, wireModelProvider: policy.wireModelProvider, workspaceMode: policy.workspaceMode,
    mode: policy.mode, evidenceMode: policy.evidenceMode, retainedContextDigest: policy.retainedContextDigest });
  const expected = clone(rebuilt);
  expected.executableIdentity.pathDigest = policy.executableIdentity.pathDigest;
  if (json(policy) !== json(expected)) fail("Codex worker policy differs from its fixed typed plan.", "INVALID_CODEX_WORKER_POLICY");
  return freeze(clone(policy));
}

// Only trusted embedding code calls this function. It is intentionally absent
// from CLI/MCP JSON. The callback must independently establish the effective
// enforcement obligations for the exact request, retain that enforcement while
// invoking commit, and fail closed when a required observation is unavailable.
// Neither callback return data, a digest nor an echoed policy issues a proof.
// This is not protection against malicious code inside the trusted Host itself.
export function createCodexWorkerPolicyHost({ evidenceMode, withVerifiedPolicy } = {}) {
  if (!["actual-provider", "protocol-fixture"].includes(evidenceMode) || typeof withVerifiedPolicy !== "function") fail("No effective Codex worker policy verifier is connected.");
  const host = Object.freeze(Object.create(null));
  hosts.set(host, { evidenceMode, withVerifiedPolicy });
  return host;
}

function exactExecutable(policy, target) {
  const file = target?.executablePath;
  if (typeof file !== "string" || !path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file)
    || hash(path.resolve(file)) !== policy.executableIdentity.pathDigest) fail("Codex worker executable path changed.", "CODEX_WORKER_EXECUTABLE_DRIFT");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) fail("Codex worker executable is not a bounded regular file.", "CODEX_WORKER_EXECUTABLE_DRIFT");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino) fail("Codex worker executable changed during open.", "CODEX_WORKER_EXECUTABLE_DRIFT");
    const digest = crypto.createHash("sha256");
    const bytes = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, bytes, 0, bytes.length, null))) digest.update(bytes.subarray(0, count));
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (digest.digest("hex") !== policy.executableIdentity.contentDigest || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs
      || named.dev !== stat.dev || named.ino !== stat.ino || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) fail("Codex worker executable bytes changed.", "CODEX_WORKER_EXECUTABLE_DRIFT");
  } finally { fs.closeSync(fd); }
}

function validate(binding, { authorization, root, target }) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const { policy, workspaceBinding } = binding;
  if (verified.authorizationId !== binding.authorizationId || verified.authorizationHash !== binding.authorizationHash
    || verified.executionInput.digest !== binding.inputDigest || verified.runtime !== "codex"
    || verified.runtimeSelection?.model !== policy.model || verified.workspaceMode !== policy.workspaceMode
    || fs.realpathSync(root) !== binding.root) fail("Codex worker proof belongs to another authorization, model or root.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  const boundary = verified.workerInput?.executionBoundary;
  if (!boundary || boundary.policyDigest !== hash(json(policy)) || boundary.workspaceBindingDigest !== workspaceBinding.bindingDigest
    || boundary.executionRootDigest !== workspaceBinding.executionRootDigest || boundary.sourceBasisDigest !== workspaceBinding.sourceBasisDigest
    || workspaceBinding.canonicalRoot !== binding.root) fail("Codex worker proof differs from the pre-authorized workspace policy.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  const prepared = prepareRuntimeInvocationExecution({ root: binding.root, authorization: verified });
  verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis: verified.workerInput.sourceBasis });
  exactExecutable(policy, target);
  return { policy, projectRoot: prepared.projectRoot, executionRoot: workspaceBinding.executionRoot,
    input: prepared.input, inputDigest: binding.inputDigest, workspaceBinding, authorization: verified };
}

export function bindCodexWorkerPolicyCapability({ host, policy, authorization, workspaceBinding, root, target } = {}) {
  const verifier = hosts.get(host);
  if (!verifier) fail("A trusted effective Codex worker policy verifier is unavailable.");
  const fixed = verifyCodexWorkerPolicyPlan(policy);
  if (fixed.evidenceMode !== verifier.evidenceMode) fail("Synthetic policy proof cannot authorize actual provider execution.", "CODEX_WORKER_POLICY_EVIDENCE_MISMATCH");
  const binding = { host, policy: fixed, workspaceBinding: freeze(clone(workspaceBinding)), root: fs.realpathSync(root),
    authorizationId: authorization.authorizationId, authorizationHash: authorization.authorizationHash,
    inputDigest: authorization.executionInput.digest, target: freeze(clone(target)) };
  validate(binding, { authorization, root, target });
  const capability = Object.freeze(Object.create(null));
  capabilities.set(capability, binding);
  return capability;
}

export function inspectCodexWorkerPolicyCapability(capability) {
  const binding = capabilities.get(capability);
  if (!binding) fail("Missing, serialized or forged Codex worker policy capability.");
  return { policy: binding.policy, workspaceBinding: binding.workspaceBinding, root: binding.root,
    authorizationId: binding.authorizationId, authorizationHash: binding.authorizationHash, inputDigest: binding.inputDigest,
    target: binding.target };
}

// Used again at the lease's exact synchronous consumption boundary after the
// outer Host has established and retained its enforcement scope.
export function verifyCodexWorkerPolicyCapability({ capability, authorization, root, target } = {}) {
  const binding = capabilities.get(capability);
  if (!binding) fail("Missing, serialized or forged Codex worker policy capability.");
  return validate(binding, { authorization, root, target });
}

// A capability is a connection to a trusted verifier, never a durable permission
// token. Revalidate each use; a prior successful use cannot certify a later one.
export async function withCodexWorkerPolicyCapability({ capability, authorization, root, target, mode = null,
  revalidate = () => {}, signal = null, deadlineUnixMs = null } = {}, commit) {
  const binding = capabilities.get(capability);
  if (!binding || typeof commit !== "function") fail("Missing, serialized or forged Codex worker policy capability.");
  if (mode !== null && binding.policy.mode !== mode) fail("Codex worker policy transport differs.", "CODEX_WORKER_POLICY_BINDING_DRIFT");
  const request = validate(binding, { authorization, root, target });
  const verifier = hosts.get(binding.host);
  const deadline = deadlineUnixMs === null ? Date.now() + authorization.limits.timeoutMs
    : Math.min(deadlineUnixMs, Date.now() + authorization.limits.timeoutMs);
  if (!Number.isSafeInteger(deadline)) fail("Invalid Codex policy verification deadline.", "INVALID_CODEX_WORKER_POLICY");
  if (signal?.aborted) fail("Codex policy verification was cancelled before consumption.", "CODEX_WORKER_POLICY_CANCELLED");
  if (Date.now() >= deadline) fail("Codex policy verification deadline expired before consumption.", "CODEX_WORKER_POLICY_TIMEOUT");
  const controller = new AbortController();
  let open = true;
  let calls = 0;
  let outcome;
  let pending;
  let pendingSettled = false;
  let verificationSettled = false;
  let timer;
  let settlementTimer;
  let abortHandler;
  const stopped = new Promise((_, reject) => {
    const stop = code => {
      if (controller.signal.aborted) return;
      const error = Object.assign(new Error("Codex policy scope ended."), { code });
      controller.abort(error);
      open = false;
      // A hung verifier is bounded both before commit and after operation
      // settlement. Once committed, never win the race until exact provider /
      // owner cleanup has settled; abort only requests that cleanup.
      if (!pending) { reject(error); return; }
      Promise.resolve(pending).catch(() => {}).then(() => {
        // A healthy guard returns the existing cancelled/timed-out invocation
        // evidence after cleanup. Give its own cleanup the authorization's
        // existing grace; only a still-hung verifier then becomes an error.
        if (!verificationSettled) settlementTimer = setTimeout(() => reject(error), authorization.limits.terminationGraceMs);
      });
    };
    timer = setTimeout(() => stop("CODEX_WORKER_POLICY_TIMEOUT"), Math.max(1, deadline - Date.now()));
    if (signal) {
      abortHandler = () => stop("CODEX_WORKER_POLICY_CANCELLED");
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    const verification = Promise.resolve().then(() => verifier.withVerifiedPolicy({ ...request, target: freeze(clone(target)),
      requiredEnforcement: binding.policy.requiredEnforcement, evidenceMode: verifier.evidenceMode,
      signal: controller.signal, deadlineUnixMs: deadline,
      commit: () => {
        if (!open || calls++ !== 0) fail("Codex worker policy callback is expired or replayed.", "CODEX_WORKER_POLICY_CALLBACK_REPLAYED");
        // Host inspection may await or call external code. Check again *inside*
        // its callback so callback-time source/model/executable drift fails before
        // the existing lease consumption is committed.
        revalidate();
        const current = validate(binding, { authorization, root, target });
        if (!open || controller.signal.aborted) fail("Codex policy was cancelled during its final verification.", "CODEX_WORKER_POLICY_CANCELLED");
        if (Date.now() >= deadline) fail("Codex policy deadline expired during its final verification.", "CODEX_WORKER_POLICY_TIMEOUT");
        pending = Promise.resolve(commit({ ...current, signal: controller.signal, deadlineUnixMs: deadline }))
          .then(value => { pendingSettled = true; outcome = value; return value; }, error => { pendingSettled = true; throw error; });
        return pending;
      } })).then(value => { verificationSettled = true; return value; }, error => { verificationSettled = true; throw error; });
    // The losing verifier is observed by Promise.race; its callback expires.
    // The stop branch above cannot settle while committed work remains pending.
    await Promise.race([verification, stopped]);
    if (calls !== 1 || !pending) fail("Host did not verify and commit the exact Codex worker policy.");
    if (!pendingSettled) fail("Host released its policy guard before the committed operation settled.", "CODEX_WORKER_POLICY_GUARD_CLOSED");
    await pending;
    return outcome;
  } catch (error) {
    // A verifier may fail after it started commit(). Keep the caller attached
    // until the exact consumed operation responds to cancellation and cleans up.
    open = false;
    controller.abort(error);
    if (pending) await pending.catch(() => {});
    throw error;
  } finally {
    open = false;
    clearTimeout(timer);
    clearTimeout(settlementTimer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}
