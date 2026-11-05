import { pathToFileURL } from "node:url";
import { executeCodexRuntimeInvocation } from "./runtime-codex-exec.mjs";
import { bindCodexWorkerPolicyCapability, verifyCodexWorkerPolicyPlan } from "./runtime-codex-worker-policy.mjs";

// Fixed detached runner. hostModuleFile comes only from trusted Host composition
// and the owner's exact code-identity verification, never from CLI/MCP input.
// The module reconnects its backend in this process; no opaque parent proof is
// serialized. Raw endpoint/provider identities remain Host-local P5 data.
export default async function runCodexWorker({ root, executionRoot, authorization, policy,
  workspaceBinding, hostModuleFile, hostConnection = null, signal, onProcess = () => {} }) {
  const fixed = verifyCodexWorkerPolicyPlan(policy);
  if (!hostModuleFile || executionRoot !== workspaceBinding?.executionRoot || root !== workspaceBinding.canonicalRoot) {
    throw Object.assign(new Error("The fixed Codex worker requires its exact Host reconnect module and roots."), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  }
  const module = await import(pathToFileURL(hostModuleFile).href);
  if (typeof module.connectCodexWorkerHost !== "function") {
    throw Object.assign(new Error("The trusted Codex Host module has no reconnect implementation."), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  }
  const connection = await module.connectCodexWorkerHost({ root, executionRoot, authorization,
    policy: fixed, workspaceBinding, hostConnection, signal, onProcess });
  let operationError;
  try {
    const execution = connection?.execution;
    if (!execution || typeof execution.targetResolver !== "function") {
      throw Object.assign(new Error("The Codex Host reconnect did not supply an executable resolver."), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
    }
    const target = execution.targetResolver({ runtime: "codex", platform: execution.platform || process.platform,
      environment: execution.environment || process.env, fileSystem: execution.fileSystem });
    const capability = bindCodexWorkerPolicyCapability({ host: connection.policyHost, policy: fixed,
      authorization, workspaceBinding, root, target });
    return await executeCodexRuntimeInvocation({ ...execution, root, authorization,
      sessionRequest: authorization.workerInput.sessionRequest || "", signal, onProcessEvent: onProcess,
      // Even trusted reconnect data cannot upgrade fixture evidence or substitute
      // a command. The adapter assembles the fixed argv in both evidence modes.
      evidenceMode: fixed.evidenceMode, providerArguments: null, persist: true }, {
      workerPolicyCapability: capability, nativeForkHost: connection.nativeForkHost || null,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    // A reconnect may own a diagnostic/RPC transport before policy binding.
    // Release that exact connection even if target resolution or binding fails.
    // Its concrete close implementation owns the deadline and tree cleanup;
    // returning here must not detach an unfinished provider promise.
    try { await connection?.close?.(); } catch (cleanupError) {
      throw Object.assign(new AggregateError([operationError, cleanupError].filter(Boolean),
        "The Codex Host connection did not confirm cleanup."), { code: "CODEX_WORKER_HOST_CLEANUP_FAILED" });
    }
  }
}
