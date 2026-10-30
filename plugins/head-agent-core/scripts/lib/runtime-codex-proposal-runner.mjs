import { executeCodexFreshProposalInvocation, executeCodexNativePrefixProposalInvocation } from "./runtime-codex-proposal.mjs";
import { verifyCodexNativePrefixPolicyPlan } from "./runtime-codex-prefix-policy.mjs";
import { verifyCodexFreshProposalPolicyPlan } from "./runtime-codex-proposal-policy.mjs";
import { createCodexFreshProposalFixtureCapability } from "./runtime-codex-app-server-transport.mjs";

// The detached owner recreates a fixed concrete backend, not a caller-selected
// module or a serialized claim of enforcement. Current policy/workspace/config
// checks and the at-most-once lease stay inside the invocation implementation.
export default async function runCodexProposal({ root, executionRoot, authorization, policy, workspaceBinding,
  hostModuleFile = null, supervisorSelection = null, signal, onProcess = () => {} }) {
  const prefix = policy?.kind === "CodexNativePrefixPolicyPlan";
  const fixed = (prefix ? verifyCodexNativePrefixPolicyPlan : verifyCodexFreshProposalPolicyPlan)(policy);
  if (hostModuleFile !== null || executionRoot !== workspaceBinding?.executionRoot || root !== workspaceBinding?.canonicalRoot) {
    throw Object.assign(new Error("Fresh proposal jobs require the fixed backend and exact selected workspace."), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  }
  // This branch is explicitly synthetic and cannot issue an actual-provider
  // receipt. Neither fixture scenario nor executable/argv are caller inputs.
  const protocolFixtureCapability = fixed.evidenceMode === "protocol-fixture"
    ? createCodexFreshProposalFixtureCapability({ scenario: prefix ? "prefix-normal" : "normal" }) : null;
  return await (prefix ? executeCodexNativePrefixProposalInvocation : executeCodexFreshProposalInvocation)({ root, authorization, policy: fixed, workspaceBinding,
    supervisorSelection, signal, onProcessEvent: onProcess, persist: true }, { protocolFixtureCapability });
}
